package com.stickersom.app

import android.app.Activity
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
import android.widget.*
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.max
import kotlin.math.min

class MainActivity : Activity() {
    private lateinit var preview: VideoView
    private lateinit var send: Button
    private lateinit var recipient: EditText
    private lateinit var startBar: SeekBar
    private lateinit var lengthBar: SeekBar
    private lateinit var startLabel: TextView
    private lateinit var lengthLabel: TextView
    private lateinit var status: TextView
    private var videoUri: Uri? = null
    private var durationMs = 0L
    private var startMs = 0
    private var clipMs = 10_000

    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); buildUi() }

    private fun buildUi() {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 28, 24, 24); setBackgroundColor(0xFF10131B.toInt()) }
        fun label(value: String, size: Float, color: Int = 0xFFFFFFFF.toInt()) = TextView(this).apply { text=value; textSize=size; setTextColor(color) }
        root.addView(label("StickerSom", 30f))
        root.addView(label("Sua ideia. Sua figurinha. Com som.", 14f, 0xFFB9C1D2.toInt()))
        preview = VideoView(this).apply { setBackgroundColor(0xFF252B38.toInt()); layoutParams=LinearLayout.LayoutParams(-1,220).apply { topMargin=22; bottomMargin=16 } }
        root.addView(preview)
        val choose = Button(this).apply { text="Escolher vídeo" }; root.addView(choose)
        startLabel=label("Início: 0,0 s",14f); root.addView(startLabel)
        startBar=SeekBar(this).apply { max=10000; isEnabled=false }; root.addView(startBar)
        lengthLabel=label("Duração: até 10 s",14f); root.addView(lengthLabel)
        lengthBar=SeekBar(this).apply { max=10000; progress=10000; isEnabled=false }; root.addView(lengthBar)
        recipient=EditText(this).apply { hint="WhatsApp de destino (DDI + DDD + número)"; setHintTextColor(0xFF858FA3.toInt()); setTextColor(-1); inputType=3; setSingleLine(true) }
        root.addView(recipient)
        send=Button(this).apply { text="Gerar figurinha sonora"; isEnabled=false }; root.addView(send)
        status=label("Deixe o bot StickerSom aberto no Termux.",13f,0xFFB9C1D2.toInt()).apply { setPadding(0,18,0,0) }; root.addView(status)
        setContentView(ScrollView(this).apply { addView(root) })

        choose.setOnClickListener { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type="video/*" },10) }
        startBar.setOnSeekBarChangeListener(listener { p -> startMs=(durationMs*p/10000L).toInt(); updateLabels() })
        lengthBar.setOnSeekBarChangeListener(listener { p -> clipMs=min(10000,max(200,(durationMs*p/10000L).toInt())); updateLabels() })
        send.setOnClickListener { submitVideo() }
    }

    private fun listener(change:(Int)->Unit)=object:SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(s:SeekBar?,p:Int,fromUser:Boolean){if(fromUser)change(p)}
        override fun onStartTrackingTouch(s:SeekBar?){}
        override fun onStopTrackingTouch(s:SeekBar?){}
    }

    @Deprecated("Legacy picker callback for broad Android compatibility")
    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?) {
        super.onActivityResult(requestCode,resultCode,data)
        if(requestCode!=10||resultCode!=RESULT_OK)return
        val uri=data?.data?:return
        contentResolver.takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION)
        videoUri=uri
        val retriever=MediaMetadataRetriever()
        try { retriever.setDataSource(this,uri); durationMs=retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?:0L } finally { retriever.release() }
        if(durationMs<200){status.text="Não consegui ler a duração desse vídeo.";return}
        startMs=0;clipMs=min(10000,durationMs.toInt())
        startBar.isEnabled=true;lengthBar.isEnabled=true;startBar.progress=0
        lengthBar.progress=(clipMs*10000L/durationMs).toInt().coerceIn(1,10000)
        preview.setVideoURI(uri);preview.setOnPreparedListener{it.isLooping=true;preview.start()}
        send.isEnabled=true;updateLabels();status.text="Vídeo pronto. Escolha o trecho e informe o destino."
    }

    private fun updateLabels() {
        val maxClip=min(10000,max(200,durationMs.toInt()-startMs));clipMs=min(clipMs,maxClip)
        startLabel.text="Início: %.1f s".format(startMs/1000f)
        lengthLabel.text="Duração: %.1f s".format(clipMs/1000f)
        videoUri?.let{preview.seekTo(startMs)}
    }

    private fun submitVideo() {
        val uri=videoUri?:return
        val number=recipient.text.toString().filter{it.isDigit()}
        if(number.length !in 8..15){recipient.error="Informe o número com DDI e DDD.";return}
        send.isEnabled=false;status.text="Preparando sua figurinha sonora…"
        Thread {
            var connection:HttpURLConnection?=null
            try {
                val bytes=contentResolver.openInputStream(uri)?.use{it.readBytes()}?:throw IllegalStateException("Não consegui abrir o vídeo.")
                if(bytes.size>16*1024*1024)throw IllegalStateException("O vídeo precisa ter até 16 MB.")
                val query="to=$number&start=$startMs&duration=$clipMs"
                connection=(URL("http://127.0.0.1:3988/sticker?$query").openConnection() as HttpURLConnection).apply {
                    requestMethod="POST";connectTimeout=10000;readTimeout=180000;doOutput=true
                    setRequestProperty("Content-Type","application/octet-stream");setFixedLengthStreamingMode(bytes.size)
                }
                connection.outputStream.use{it.write(bytes)}
                val code=connection.responseCode
                val response=(if(code in 200..299)connection.inputStream else connection.errorStream)?.bufferedReader()?.use{it.readText()}?:""
                if(code !in 200..299)throw IllegalStateException(response.ifBlank{"Erro $code. Confira se o bot está conectado no Termux."})
                runOnUiThread{status.text="Figurinha sonora enviada! 🔊";Toast.makeText(this,"StickerSom enviado!",Toast.LENGTH_LONG).show()}
            } catch(e:Exception) { runOnUiThread{status.text=e.message?:"Falha ao enviar. Confira o Termux."} }
            finally { connection?.disconnect();runOnUiThread{send.isEnabled=true} }
        }.start()
    }
}