// Called only after the upgrade has stopped API/Worker, backed up and migrated.
// The installation file lock and pending gate remain held across the DB restart.
export async function restartDatabase(platform) {
  await platform.disconnect();
  await platform.disableRecovery();
  await platform.stop();
  await platform.refresh();
  await platform.start();
  await platform.reconnect();
}
