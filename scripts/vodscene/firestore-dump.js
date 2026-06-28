#!/usr/bin/env node
/**
 * firestore-dump.js
 * Login con Firebase REST API y vuelca todas las colecciones Firestore accesibles a JSON.
 * Uso: node firestore-dump.js [output.json]
 */

const fs = require("fs");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const FIREBASE_API_KEY = "AIzaSyAUPv7dU2kEk1rdC__6z8aGlPYPfQh_ogA";
const FIREBASE_PROJECT = "payperview-7c21f";
const CF_REGION        = "us-central1";
const EMAIL            = "m45942076@gmail.com";
const PASSWORD         = "minasricas00";
const OUTPUT_FILE      = process.argv[2] || "firestore-data.json";

// Colecciones candidatas a probar (listCollectionIds requiere admin — probamos por nombre)
const CANDIDATE_COLLECTIONS = [
    "videos", "users", "participants", "creators", "playlists",
    "purchases", "transactions", "sessions", "activeSessions",
    "subscriptions", "coupons", "earnings", "payouts",
    "notifications", "config", "settings", "categories", "tags",
    "comments", "reviews", "reports", "analytics", "events",
];

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const CF_URL  = `https://${CF_REGION}-${FIREBASE_PROJECT}.cloudfunctions.net/registerUserSession`;

// ─── FETCH HELPER ─────────────────────────────────────────────────────────────
async function fetchJSON(url, options = {}) {
    const res  = await fetch(url, options);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
    return { ok: res.ok, status: res.status, statusText: res.statusText, json };
}

// ─── FIRESTORE TYPE CONVERTER ─────────────────────────────────────────────────
function fsVal(v) {
    if (!v || typeof v !== "object") return v;
    if ("stringValue"    in v) return v.stringValue;
    if ("integerValue"   in v) return parseInt(v.integerValue, 10);
    if ("doubleValue"    in v) return v.doubleValue;
    if ("booleanValue"   in v) return v.booleanValue;
    if ("nullValue"      in v) return null;
    if ("timestampValue" in v) return v.timestampValue;
    if ("mapValue"       in v) return fsFields(v.mapValue.fields || {});
    if ("arrayValue"     in v) return (v.arrayValue.values || []).map(fsVal);
    return v;
}
function fsFields(fields) {
    const obj = {};
    for (const [k, val] of Object.entries(fields)) obj[k] = fsVal(val);
    return obj;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
    // 1. Firebase sign-in
    console.log(`[AUTH] Signing in as ${EMAIL}...`);
    const signIn = await fetchJSON(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Referer": "https://vodscene.com/",
                "Origin":  "https://vodscene.com",
            },
            body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
        }
    );
    if (!signIn.ok) {
        console.error("[AUTH] ❌ Login fallido:", JSON.stringify(signIn.json));
        process.exit(1);
    }
    const { idToken, localId: uid } = signIn.json;
    console.log(`[AUTH] ✅ uid: ${uid}`);

    // 2. registerUserSession (CF) para obtener session token
    console.log("[CF] Llamando registerUserSession...");
    const cfRes = await fetchJSON(CF_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${idToken}`,
        },
        body: JSON.stringify({ uid, userAgent: "Mozilla/5.0", platform: "web" }),
    });
    if (!cfRes.ok) {
        console.warn(`[CF] ⚠️ registerUserSession: ${cfRes.status} ${cfRes.statusText} — usando idToken directamente`);
    } else {
        console.log("[CF] ✅ sessionData keys:", Object.keys(cfRes.json).join(", "));
    }

    // 3. Dump Firestore
    const headers = { "Authorization": `Bearer ${idToken}`, "Content-Type": "application/json" };
    const result  = {};
    let   totalDocs = 0;

    console.log(`\n[FIRESTORE] Probando ${CANDIDATE_COLLECTIONS.length} colecciones candidatas...`);

    for (const collectionId of CANDIDATE_COLLECTIONS) {
        // Probe: 1 documento para verificar acceso
        const probe = await fetchJSON(`${FS_BASE}/${collectionId}?pageSize=1`, { headers });

        if (probe.status === 401 || probe.status === 403) {
            console.log(`[FIRESTORE]   ⛔ ${collectionId}: sin acceso (${probe.status})`);
            continue;
        }
        if (!probe.ok) {
            // 404 con error NOT_FOUND → colección inexistente
            if (probe.json?.error?.status === "NOT_FOUND") {
                console.log(`[FIRESTORE]   ○  ${collectionId}: no existe`);
            } else {
                console.warn(`[FIRESTORE]   ⚠️ ${collectionId}: ${probe.status} ${probe.statusText}`);
            }
            continue;
        }

        console.log(`[FIRESTORE] → ${collectionId}: accesible — descargando...`);
        result[collectionId] = {};
        let pageToken = null;
        let pageNum   = 0;

        // Primera página ya la tenemos (probe)
        const processBody = (body) => {
            const docs = body.documents || [];
            pageNum++;
            for (const doc of docs) {
                const id = doc.name.split("/").pop();
                result[collectionId][id] = doc.fields ? fsFields(doc.fields) : {};
            }
            pageToken = body.nextPageToken || null;
            const total = Object.keys(result[collectionId]).length;
            console.log(`[FIRESTORE]   Pág ${pageNum}: ${docs.length} docs  (acum ${collectionId}: ${total})`);
        };

        processBody(probe.json);

        // Páginas siguientes
        while (pageToken) {
            const url  = `${FS_BASE}/${collectionId}?pageSize=300&pageToken=${encodeURIComponent(pageToken)}`;
            const page = await fetchJSON(url, { headers });
            if (!page.ok) {
                console.warn(`[FIRESTORE]   ⚠️ Paginación ${collectionId} pág ${pageNum + 1}: ${page.status}`);
                break;
            }
            processBody(page.json);
        }

        const count = Object.keys(result[collectionId]).length;
        totalDocs += count;
        console.log(`[FIRESTORE]   ✅ ${collectionId}: ${count} documentos`);
    }

    // 4. Guardar
    const accessibleCols = Object.keys(result);
    console.log(`\n[FIRESTORE] ✅ ${accessibleCols.length} colecciones accesibles: ${accessibleCols.join(", ")}`);
    console.log(`[FIRESTORE] ✅ Total documentos: ${totalDocs}`);

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    console.log(`[SUCCESS] Guardado en ${OUTPUT_FILE}`);
})();
