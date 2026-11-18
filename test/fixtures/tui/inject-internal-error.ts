// Preloaded into the real `cusr` by a test only (NODE_OPTIONS=--import): SIGUSR2 raises an uncaught error
// once the interface is up, so the real error path runs without any hook in the runtime.
process.on('SIGUSR2', () => {
  setTimeout(() => {
    throw new Error('injected internal error');
  }, 0);
});
