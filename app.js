const $ = (id) => document.getElementById(id);
const visualInput = $("visualFile"), audioInput = $("audioFile"), imagePreview = $("imagePreview"), videoPreview = $("videoPreview");
let mode = "image", visualUrl = null, audioUrl = null, visualKind = null, busy = false;

function setMode(next) {
  mode = next;
  document.querySelectorAll(".mode-option").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  $("audioField").hidden = mode === "video";
  $("visualFile").accept = mode === "image" ? "image/*" : "video/*";
  $("visualName").textContent = mode === "image" ? "PNG, JPG ou GIF" : "MP4, MOV ou WebM";
  if (mode === "image" && visualKind === "video") clearVisual();
  if (mode !== "image" && visualKind === "image") clearVisual();
  updateReady();
}
document.querySelectorAll(".mode-option").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.querySelectorAll("[data-mode-link]").forEach(a => a.addEventListener("click", () => setMode(a.dataset.modeLink)));

function clearVisual() {
  if (visualUrl) URL.revokeObjectURL(visualUrl);
  visualUrl = null; visualKind = null; visualInput.value = "";
  imagePreview.hidden = true; videoPreview.pause(); videoPreview.hidden = true;
  $("visualName").textContent = "PNG, JPG, GIF ou MP4";
  $("fileMeta").textContent = "Nenhum arquivo selecionado";
}
visualInput.addEventListener("change", () => {
  const file = visualInput.files[0]; if (!file) return;
  const isVideo = file.type.startsWith("video/");
  if ((mode === "image" && isVideo) || (mode !== "image" && !isVideo)) {
    setStatus(mode === "image" ? "Neste modo, escolha uma imagem ou GIF." : "Neste modo, escolha um arquivo de vídeo.");
    visualInput.value = ""; return;
  }
  clearVisual(); visualInput.files = visualInput.files;
  visualUrl = URL.createObjectURL(file); visualKind = isVideo ? "video" : "image";
  $("visualName").textContent = file.name; $("fileMeta").textContent = formatBytes(file.size);
  if (isVideo) { videoPreview.src = visualUrl; videoPreview.hidden = false; imagePreview.hidden = true; videoPreview.muted = true; }
  else { imagePreview.src = visualUrl; imagePreview.hidden = false; videoPreview.hidden = true; }
  $("exportResult").hidden = true; updateReady(); setStatus("Arquivo carregado. Tudo pronto para criar!");
});
audioInput.addEventListener("change", () => {
  const file = audioInput.files[0]; if (!file) return;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(file); $("audioName").textContent = file.name;
  $("exportResult").hidden = true; updateReady();
});
$("duration").addEventListener("input", e => $("durationValue").textContent = e.target.value);
$("volume").addEventListener("input", e => $("volumeValue").textContent = e.target.value);
function updateReady() {
  $("createBtn").disabled = busy || !visualUrl || (mode !== "video" && !audioUrl);
}
function setStatus(text) { $("status").textContent = text; }
function formatBytes(n) { return n < 1048576 ? (n/1024).toFixed(0)+" KB" : (n/1048576).toFixed(1)+" MB"; }
$("visualDrop").addEventListener("dragover", e => { e.preventDefault(); $("visualDrop").classList.add("dragover"); });
$("visualDrop").addEventListener("dragleave", () => $("visualDrop").classList.remove("dragover"));
$("visualDrop").addEventListener("drop", e => {
  e.preventDefault(); $("visualDrop").classList.remove("dragover");
  if (e.dataTransfer.files.length) { visualInput.files = e.dataTransfer.files; visualInput.dispatchEvent(new Event("change")); }
});

function waitEvent(el, event, timeout=12000) {
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(new Error("Tempo limite ao carregar mídia.")),timeout);
    el.addEventListener(event,()=>{clearTimeout(timer);resolve();},{once:true});
    el.addEventListener("error",()=>{clearTimeout(timer);reject(new Error("Não foi possível ler este arquivo."));},{once:true});
  });
}
async function createSticker() {
  if (busy || !visualUrl) return;
  busy=true; updateReady(); $("exportResult").hidden=true;
  let ctx, raf, recorder, chunks=[];
  try {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error("Seu navegador não oferece exportação de vídeo. Tente a versão mais recente do Chrome ou Edge.");
    const duration=Number($("duration").value), canvas=document.createElement("canvas");
    canvas.width=512; canvas.height=512;
    const g=canvas.getContext("2d");
    const video=mode==="image" ? null : document.createElement("video");
    let sourceAudio=null, mediaStream=null, audioTracks=[];
    if (video) {
      video.src=visualUrl; video.muted=false; video.playsInline=true; video.loop=true;
      await waitEvent(video,"loadedmetadata"); await video.play();
    }
    ctx=new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const destination=ctx.createMediaStreamDestination();
    if (mode==="video") {
      // Route the video's own audio into the export stream.
      sourceAudio=ctx.createMediaElementSource(video);
      sourceAudio.connect(destination);
    } else {
      const audio=new Audio(audioUrl); audio.crossOrigin="anonymous";
      await waitEvent(audio,"canplay"); audio.loop=true;
      const audioNode=ctx.createMediaElementSource(audio);
      const gain=ctx.createGain(); gain.gain.value=Number($("volume").value)/100;
      audioNode.connect(gain); gain.connect(destination); audio.play();
      window.__stickerSomAudio=audio;
    }
    const videoStream=canvas.captureStream(30);
    mediaStream=new MediaStream([...videoStream.getVideoTracks(),...destination.stream.getAudioTracks()]);
    const mime=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"].find(t=>MediaRecorder.isTypeSupported(t));
    if (!mime) throw new Error("Este navegador não suporta o formato de exportação necessário.");
    recorder=new MediaRecorder(mediaStream,{mimeType:mime});
    const done=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onstop=resolve;recorder.onerror=()=>reject(new Error("Falha durante a exportação."));});
    const draw=()=>{
      g.clearRect(0,0,512,512); g.fillStyle="#11111a"; g.fillRect(0,0,512,512);
      if (video && video.readyState>=2) drawCover(g,video,512,512);
      else if (!video && imagePreview.complete) drawContain(g,imagePreview,512,512);
      raf=requestAnimationFrame(draw);
    };
    draw(); recorder.start(250);
    setStatus("Criando sua figurinha... mantenha esta aba aberta.");
    await new Promise(r=>setTimeout(r,duration*1000));
    recorder.stop(); await done; cancelAnimationFrame(raf);
    const blob=new Blob(chunks,{type:mime}), url=URL.createObjectURL(blob);
    $("downloadLink").href=url; $("downloadLink").download="stickersom.webm";
    $("exportResult").hidden=false; setStatus("Prontinho! Seu arquivo está disponível para baixar.");
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    if (window.__stickerSomAudio) { window.__stickerSomAudio.pause(); window.__stickerSomAudio=null; }
    videoStream.getTracks().forEach(t=>t.stop()); destination.stream.getTracks().forEach(t=>t.stop());
    ctx.close();
  } catch(err) {
    if (raf) cancelAnimationFrame(raf);
    if (recorder && recorder.state!=="inactive") recorder.stop();
    if (ctx && ctx.state!=="closed") await ctx.close();
    setStatus(err.message || "Não foi possível criar o arquivo.");
  } finally { busy=false; updateReady(); }
}
function drawCover(c,source,w,h) {
  const sw=source.videoWidth||w, sh=source.videoHeight||h, scale=Math.max(w/sw,h/sh);
  const dw=sw*scale, dh=sh*scale; c.drawImage(source,(w-dw)/2,(h-dh)/2,dw,dh);
}
function drawContain(c,source,w,h) {
  const sw=source.naturalWidth||w, sh=source.naturalHeight||h, scale=Math.min(w/sw,h/sh);
  const dw=sw*scale, dh=sh*scale; c.drawImage(source,(w-dw)/2,(h-dh)/2,dw,dh);
}
$("createBtn").addEventListener("click",createSticker);
updateReady();