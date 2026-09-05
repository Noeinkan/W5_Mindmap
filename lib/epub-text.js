"use strict";

/**
 * An EPUB, read as its chapters in reading order.
 *
 * The format is friendlier than a PDF about this: the text is already text, the
 * order is written down in the spine, and the table of contents points at whole
 * documents rather than at coordinates on a page. So the work here is following
 * three files to each other — the container names the package, the package names
 * the chapters and their order, the navigation names the sections — and handing
 * the result to `sections.js`, which does not care which format it came from.
 */

const { readZip } = require("./zip");
const { htmlToText } = require("./html-text");

const CONTAINER = "META-INF/container.xml";
const XHTML = /(x?html|xml)/i;

class EpubError extends Error {
  constructor(message, code = "bad_epub") {
    super(message);
    this.name = "EpubError";
    this.code = code;
  }
}

/**
 * @param {Buffer} buffer
 * @returns {{documents: string[], marks: Array<{title: string, unit: number, depth: number}>, title: string, warnings: string[]}}
 */
function epubToDocuments(buffer) {
  const warnings = [];
  const zip = readZip(buffer);

  const packagePath = findPackage(zip);
  const packageXml = zip.text(packagePath);
  if (!packageXml) throw new EpubError("This EPUB has no package file, so its chapters cannot be ordered.");

  const base = directoryOf(packagePath);
  const manifest = readManifest(packageXml, base);
  const spine = readSpine(packageXml, manifest, warnings);

  if (!spine.length) throw new EpubError("This EPUB lists no readable chapters.");

  const documents = spine.map((item) => {
    const html = zip.text(item.path);
    if (html === null) {
      warnings.push(`"${item.path}" is listed in this EPUB but not in the file.`);
      return "";
    }
    return htmlToText(html);
  });

  return {
    documents,
    marks: readContents(zip, packageXml, manifest, spine, warnings),
    title: firstTag(packageXml, "dc:title") || firstTag(packageXml, "title"),
    warnings
  };
}

/** The container points at the package; a broken one is worth guessing around. */
function findPackage(zip) {
  const container = zip.text(CONTAINER);
  const rootfile = container ? /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(container) : null;
  if (rootfile && zip.has(decodeURIComponent(rootfile[1]))) return decodeURIComponent(rootfile[1]);

  const guess = zip.names.find((name) => name.toLowerCase().endsWith(".opf"));
  if (guess) return guess;
  throw new EpubError("This does not look like an EPUB: it has no package file.");
}

function readManifest(packageXml, base) {
  const items = new Map();
  const section = /<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i.exec(packageXml);
  const body = section ? section[1] : packageXml;

  for (const tag of body.match(/<item\b[^>]*>/gi) || []) {
    const id = attribute(tag, "id");
    const href = attribute(tag, "href");
    if (!id || !href) continue;
    items.set(id, {
      id,
      href,
      path: resolvePath(base, href),
      type: attribute(tag, "media-type") || "",
      properties: attribute(tag, "properties") || ""
    });
  }
  return items;
}

/** The spine is the reading order: which chapter comes after which. */
function readSpine(packageXml, manifest, warnings) {
  const section = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(packageXml);
  const spine = [];

  for (const tag of (section ? section[1] : "").match(/<itemref\b[^>]*>/gi) || []) {
    const item = manifest.get(attribute(tag, "idref"));
    if (!item) continue;
    // "nav" is the table of contents itself — a list of links, not a chapter.
    if (item.properties.split(/\s+/).includes("nav")) continue;
    if (item.type && !XHTML.test(item.type)) continue;
    spine.push(item);
  }

  if (spine.length) return spine;

  // No usable spine. The chapters are still in the manifest, and its order is
  // the order the writer wrote them in more often than not.
  warnings.push("This EPUB has no reading order, so its chapters are in the order the file lists them.");
  return [...manifest.values()].filter((item) => XHTML.test(item.type) && !item.properties.includes("nav"));
}

/* ------------------------------------------------------------------ */
/* Table of contents                                                   */
/* ------------------------------------------------------------------ */

/**
 * The contents, from whichever of the two the book carries: the EPUB 3 navigation
 * document, or the EPUB 2 NCX. Each entry becomes a mark on the spine document it
 * points at.
 */
function readContents(zip, packageXml, manifest, spine, warnings) {
  const unitOf = new Map();
  spine.forEach((item, index) => {
    if (!unitOf.has(item.path)) unitOf.set(item.path, index);
  });

  const nav = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes("nav"));
  const ncxId = attribute(/<spine\b[^>]*>/i.exec(packageXml)?.[0] || "", "toc");
  const ncx =
    manifest.get(ncxId) || [...manifest.values()].find((item) => item.type.includes("dtbncx"));

  const entries = [];
  if (nav) entries.push(...parseNavigation(zip.text(nav.path) || "", directoryOf(nav.path)));
  if (!entries.length && ncx) entries.push(...parseNcx(zip.text(ncx.path) || "", directoryOf(ncx.path)));

  const marks = [];
  for (const entry of entries) {
    const unit = unitOf.get(entry.path);
    if (unit === undefined || !entry.title) continue;
    marks.push({ title: entry.title, unit, depth: entry.depth });
  }
  if (entries.length && !marks.length) {
    warnings.push("This EPUB's table of contents points at documents that are not in its reading order.");
  }
  return marks;
}

/** The EPUB 3 nav document: nested <ol> lists, one <a> per entry. */
function parseNavigation(html, base) {
  const toc =
    /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(html) ||
    /<nav\b[^>]*role\s*=\s*["'][^"']*doc-toc[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(html) ||
    /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(html);
  const body = toc ? toc[1] : html;

  const entries = [];
  const tags = /<(\/?)(ol|a)\b([^>]*)>/gi;
  let depth = -1;
  let match;

  while ((match = tags.exec(body)) !== null) {
    const [, closing, tag, attrs] = match;
    if (tag.toLowerCase() === "ol") {
      depth += closing ? -1 : 1;
      continue;
    }
    if (closing) continue;

    const href = attribute(attrs, "href");
    if (!href) continue;
    const end = body.indexOf("</a>", tags.lastIndex);
    const title = htmlToText(body.slice(tags.lastIndex, end === -1 ? tags.lastIndex : end)).replace(/\n/g, " ");
    entries.push({ title: title.trim(), path: resolvePath(base, href), depth: Math.max(0, depth) });
  }
  return entries;
}

/** The EPUB 2 NCX: navPoints that nest, each with a label and a target. */
function parseNcx(xml, base) {
  const entries = [];
  const tokens = /<(\/?)navPoint\b[^>]*>|<text\b[^>]*>([\s\S]*?)<\/text>|<content\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let depth = -1;
  let pending = null;
  let match;

  while ((match = tokens.exec(xml)) !== null) {
    const [whole, closing, label, src] = match;

    if (/^<\/?navPoint/i.test(whole)) {
      if (closing) depth -= 1;
      else {
        depth += 1;
        pending = { title: "", path: "", depth };
      }
      continue;
    }
    if (!pending) continue;
    if (label !== undefined && !pending.title) pending.title = htmlToText(label).replace(/\n/g, " ").trim();
    if (src !== undefined && !pending.path) {
      pending.path = resolvePath(base, src);
      entries.push(pending);
      pending = null;
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Paths and tags                                                      */
/* ------------------------------------------------------------------ */

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(String(tag || ""));
  return match ? match[1] : "";
}

function firstTag(xml, name) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return match ? htmlToText(match[1]).replace(/\n/g, " ").trim() : "";
}

function directoryOf(path) {
  const cut = String(path).lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** An href inside the book, as the name the archive knows it by. */
function resolvePath(base, href) {
  const clean = decodeURIComponent(String(href).split("#")[0].split("?")[0]).replace(/\\/g, "/");
  if (clean.startsWith("/")) return clean.slice(1);

  const parts = (base ? `${base}/${clean}` : clean).split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

module.exports = { epubToDocuments, EpubError, resolvePath };
