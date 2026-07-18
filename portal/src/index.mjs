import { loadConfig } from './config.mjs';
import { createPortalServer } from './server.mjs';
import { ShareClient } from './share-client.mjs';
import { Store } from './store.mjs';

const config = loadConfig();
const store = new Store(config.dataPath, config);
const shareClient = new ShareClient(config.shareInternalUrl);
const server = createPortalServer({ config, store, shareClient });

if (config.adminPassword === 'change-me-now') {
  console.warn('[portal] WARNING: ADMIN_PASSWORD is still the example value. Change it before exposing the service.');
}

const cleanupTimer = setInterval(() => {
  try { store.cleanup(); } catch (error) { console.error('[portal] cleanup failed:', error); }
}, 10 * 60_000);
cleanupTimer.unref();

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[portal] ${config.siteName} listening on 0.0.0.0:${config.port}`);
  console.log(`[portal] share internal: ${config.shareInternalUrl}`);
  console.log(`[portal] share public: ${config.sharePublicUrl}`);
});

function shutdown(signal) {
  console.log(`[portal] received ${signal}, shutting down`);
  clearInterval(cleanupTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
