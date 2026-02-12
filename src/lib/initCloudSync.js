import initializeCloudSync from "@/shared/services/initializeCloudSync";

// Initialize cloud sync when this module is imported
let initialized = false;

export async function ensureCloudSyncInitialized() {
  if (!initialized) {
    try {
      await initializeCloudSync();
      initialized = true;
    } catch (error) {
      console.error("[ServerInit] Error initializing cloud sync:", error);
    }
  }
  return initialized;
}

// Auto-initialize when module loads
const isNextBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
if (!isNextBuildPhase) {
  // Automatically trigger cloud sync initialization during non-build phases to ensure the service is ready on startup
  ensureCloudSyncInitialized().catch(console.log);
}

export default ensureCloudSyncInitialized;
