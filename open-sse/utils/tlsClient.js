import { createRequire } from "module";
import { Readable } from "stream";

const require = createRequire(import.meta.url);
const { createSession } = require("wreq-js");

/**
 * TLS Client — Chrome 124 TLS fingerprint spoofing via wreq-js
 * Singleton instance used to disguise Node.js TLS handshake as Chrome browser.
 */
class TlsClient {
  constructor() {
    this.userAgent = "antigravity/1.104.0 darwin/arm64";
    this.session = null;
  }

  async getSession() {
    if (this.session) return this.session;
    this.session = await createSession({
      browser: "chrome_124",
      os: "macos",
      userAgent: this.userAgent
    });
    return this.session;
  }

  async fetch(url, options = {}) {
    const session = await this.getSession();
    const method = (options.method || "GET").toUpperCase();

    const wreqOptions = {
      method,
      headers: options.headers,
      body: options.body,
      redirect: options.redirect === "manual" ? "manual" : "follow",
    };

    try {
      const response = await session.fetch(url, wreqOptions);
      return new ResponseWrapper(response);
    } catch (error) {
      console.error("[TlsClient] wreq-js fetch failed:", error.message);
      throw error;
    }
  }

  async exit() {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
  }
}

/**
 * Wraps wreq-js response to match standard fetch Response interface
 */
class ResponseWrapper {
  constructor(wreqResponse) {
    this.status = wreqResponse.status;
    this.statusText = wreqResponse.statusText || (this.status === 200 ? "OK" : `Status ${this.status}`);
    this.headers = new HeadersCompat(wreqResponse.headers);
    this.url = wreqResponse.url;
    this.ok = this.status >= 200 && this.status < 300;

    if (wreqResponse.body) {
      if (typeof wreqResponse.body.getReader === "function") {
        this.body = wreqResponse.body;
      } else {
        this.body = Readable.toWeb(wreqResponse.body);
      }
    } else {
      this.body = null;
    }
  }

  async text() {
    if (!this.body) return "";
    const reader = this.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(typeof value === "string" ? Buffer.from(value) : value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async json() {
    const text = await this.text();
    return JSON.parse(text);
  }

  clone() {
    // Minimal clone — creates a new wrapper that shares status/headers
    // but allows independent body consumption via stored text
    const cloned = Object.create(ResponseWrapper.prototype);
    cloned.status = this.status;
    cloned.statusText = this.statusText;
    cloned.headers = this.headers;
    cloned.url = this.url;
    cloned.ok = this.ok;
    cloned.body = this.body;
    
    // Store original text() for clone usage
    const originalText = this.text.bind(this);
    let cachedText = null;
    
    const getText = async () => {
      if (cachedText === null) cachedText = await originalText();
      return cachedText;
    };
    
    this.text = getText;
    cloned.text = getText;
    cloned.json = async () => JSON.parse(await getText());
    this.json = async () => JSON.parse(await getText());
    
    return cloned;
  }
}

/**
 * Minimal Headers compatibility class for wreq-js responses
 */
class HeadersCompat {
  constructor(headersObj = {}) {
    this.map = new Map();
    for (const [key, value] of Object.entries(headersObj)) {
      this.map.set(key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value);
    }
  }

  get(name) { return this.map.get(name.toLowerCase()) || null; }
  has(name) { return this.map.has(name.toLowerCase()); }
  forEach(callback) { this.map.forEach(callback); }
}

export default new TlsClient();
