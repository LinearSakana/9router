/**
 * Project ID Service - Fetch and cache real Project IDs from Google Cloud Code API
 *
 * Reference: CLIProxyAPI internal/auth/antigravity/auth.go (FetchProjectID + OnboardUser)
 *
 * Instead of generating random project IDs (e.g. "useful-spark-a1b2c"),
 * this service fetches the real Project ID bound to the authenticated user's account.
 * This significantly reduces the risk of being flagged by Google's anti-abuse systems.
 */

import {ANTIGRAVITY_HEADERS, CLIENT_METADATA, CLOUD_CODE_API, getPlatformUserAgent} from "../config/constants.js";

// In-memory cache: connectionId -> { projectId, fetchedAt }
const projectIdCache = new Map();

// Cache TTL: 1 hour
const CACHE_TTL_MS = 60 * 60 * 1000;

// Prevent concurrent fetches for the same connection
const pendingFetches = new Map();

/**
 * Get the Project ID for a connection, with caching.
 * Returns null on failure (callers should fall back to random generation).
 *
 * @param {string} connectionId - The connection identifier for cache keying
 * @param {string} accessToken - Valid OAuth access token
 * @returns {Promise<string|null>} Real project ID or null
 */
export async function getProjectIdForConnection(connectionId, accessToken) {
    if (!connectionId || !accessToken) return null;

    // Check cache
    const cached = projectIdCache.get(connectionId);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        return cached.projectId;
    }

    // Deduplicate concurrent fetches for the same connection
    if (pendingFetches.has(connectionId)) {
        return pendingFetches.get(connectionId);
    }

    const fetchPromise = (async () => {
        try {
            // console.log(`[ProjectId] Fetching project ID for connection ${connectionId.slice(0, 8)}...`);
            const projectId = await fetchProjectId(accessToken);

            if (projectId) {
                projectIdCache.set(connectionId, {projectId, fetchedAt: Date.now()});
                // console.log(`[ProjectId] Fetched project ID: ${projectId} for connection ${connectionId.slice(0, 8)}`);
                return projectId;
            }
            log?.warn?.("[ProjectId] could not fetch projectId for connection", {connectionId: connectionId.slice(0, 8)});
            return null;
        } catch (error) {
            console.warn(`[ProjectId] Error fetching project ID: ${error.message}`);
            return null;
        } finally {
            pendingFetches.delete(connectionId);
        }
    })();

    pendingFetches.set(connectionId, fetchPromise);
    return fetchPromise;
}

/**
 * Invalidate cached project ID for a connection.
 * Call this when a connection's credentials are fully revoked or removed.
 */
export function invalidateProjectId(connectionId) {
    projectIdCache.delete(connectionId);
}

/**
 * Fetch project ID via loadCodeAssist endpoint.
 * If loadCodeAssist doesn't return a project, falls back to onboardUser.
 *
 * @param {string} accessToken
 * @returns {Promise<string|null>}
 */
async function fetchProjectId(accessToken) {
    const reqBody = {
        metadata: CLIENT_METADATA,
        mode: 1
    };

    const response = await fetch(CLOUD_CODE_API.loadCodeAssist, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": getPlatformUserAgent(),
            ...ANTIGRAVITY_HEADERS
        },
        body: JSON.stringify(reqBody)
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`loadCodeAssist failed: HTTP ${response.status} ${errorText.slice(0, 200)}`);
    }

    const data = await response.json();

    // Extract projectID from response (multiple possible formats)
    let projectId = extractProjectId(data);

    if (projectId) {
        return projectId;
    }

    // No project ID found — try onboardUser with tier from response
    let tierID = "legacy-tier";
    if (Array.isArray(data.allowedTiers)) {
        for (const tier of data.allowedTiers) {
            if (tier && typeof tier === "object" && tier.isDefault === true) {
                if (tier.id && typeof tier.id === "string" && tier.id.trim()) {
                    tierID = tier.id.trim();
                    break;
                }
            }
        }
    }

    return await onboardUser(accessToken, tierID);
}

/**
 * Fetch project ID via onboardUser endpoint (polling for completion).
 *
 * @param {string} accessToken
 * @param {string} tierID
 * @returns {Promise<string|null>}
 */
async function onboardUser(accessToken, tierID) {
    console.log(`[ProjectId] Onboarding user with tier: ${tierID}`);

    const reqBody = {
        tierId: tierID,
        metadata: CLIENT_METADATA,
        mode: 1
    };

    const MAX_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await fetch(CLOUD_CODE_API.onboardUser, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    "User-Agent": getPlatformUserAgent(),
                    ...ANTIGRAVITY_HEADERS
                },
                body: JSON.stringify(reqBody),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                throw new Error(`onboardUser HTTP ${response.status}: ${errorText.slice(0, 200)}`);
            }

            const data = await response.json();

            if (data.done === true) {
                const projectId = extractProjectIdFromOnboard(data);
                if (projectId) {
                    console.log(`[ProjectId] Successfully onboarded, project ID: ${projectId}`);
                    return projectId;
                }
                throw new Error("onboardUser done but no project_id in response");
            }

            // Not done yet, wait and retry
            console.log(`[ProjectId] Onboard attempt ${attempt}/${MAX_ATTEMPTS}: not done yet, waiting...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            clearTimeout(timeout);
            if (attempt === MAX_ATTEMPTS) {
                console.warn(`[ProjectId] onboardUser failed after ${MAX_ATTEMPTS} attempts: ${error.message}`);
                return null;
            }
            // For non-last attempts, only throw on non-retryable errors
            if (error.name === "AbortError") {
                console.warn(`[ProjectId] onboardUser attempt ${attempt} timed out`);
                continue;
            }
            throw error;
        }
    }

    return null;
}

/**
 * Extract project ID from loadCodeAssist response.
 */
function extractProjectId(data) {
    if (!data) return null;

    // Direct string
    if (typeof data.cloudaicompanionProject === "string") {
        const id = data.cloudaicompanionProject.trim();
        if (id) return id;
    }

    // Object with id field
    if (data.cloudaicompanionProject && typeof data.cloudaicompanionProject === "object") {
        const id = data.cloudaicompanionProject.id;
        if (typeof id === "string" && id.trim()) {
            return id.trim();
        }
    }

    return null;
}

/**
 * Extract project ID from onboardUser response.
 */
function extractProjectIdFromOnboard(data) {
    if (!data?.response) return null;

    const responseData = data.response;
    const project = responseData.cloudaicompanionProject;

    if (typeof project === "string") {
        const id = project.trim();
        if (id) return id;
    }

    if (project && typeof project === "object") {
        const id = project.id;
        if (typeof id === "string" && id.trim()) {
            return id.trim();
        }
    }

    return null;
}
