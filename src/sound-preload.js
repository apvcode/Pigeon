const { ipcRenderer } = require('electron');

const activeAudioPool = new Set();

// Предварительный тихий прогрев аудио-подсистемы ОС (WASAPI/PipeWire/Pulse/CoreAudio)
try {
  const silentWarmup = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
  silentWarmup.volume = 0.001;
  silentWarmup.play().catch(() => {});
} catch (e) {}

ipcRenderer.on('play-sound', (_event, dataUri) => {
  if (!dataUri) return;
  try {
    const audio = new Audio(dataUri);
    audio.volume = 1.0;
    activeAudioPool.add(audio);

    const cleanup = () => {
      activeAudioPool.delete(audio);
    };

    audio.onended = cleanup;
    audio.onerror = (err) => {
      cleanup();
      console.warn('[Pigeon Sound Worker] audio error:', err);
    };

    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        cleanup();
        console.warn('[Pigeon Sound Worker] play rejected:', err);
      });
    }
  } catch (err) {
    console.error('[Pigeon Sound Worker] play exception:', err);
  }
});
