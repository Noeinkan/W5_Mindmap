"use strict";

// Transcripts carry meaning in their line structure: "IM: And agree the CDE naming
// convention this month" only reads as a speaker turn while the newline before it
// survives. So chunks are built out of whole lines, and a line is only broken apart
// when it alone exceeds the limit.

function splitLongLine(line, limit) {
  const words = line.split(/\s+/).filter(Boolean);
  const parts = [];
  let current = "";

  words.forEach((word) => {
    if (!current) {
      current = word;
      return;
    }
    if (current.length + word.length + 1 > limit) {
      parts.push(current);
      current = word;
      return;
    }
    current += ` ${word}`;
  });

  if (current) parts.push(current);
  return parts.length ? parts : [line];
}

function joinedLength(lines) {
  if (!lines.length) return 0;
  return lines.reduce((sum, line) => sum + line.length, 0) + lines.length - 1;
}

/**
 * Split a transcript into chunks of at most `maxLen` characters, cutting only at
 * line boundaries. Each chunk repeats the last `overlapLines` lines of the previous
 * one so a thought that straddles a cut is still visible whole to the model; the
 * duplicate concepts this produces are collapsed again by mergeGraphs.
 */
function pack(units, limit, overlap) {
  const chunks = [];
  let current = [];

  const flush = () => {
    const joined = current.join("\n").trim();
    if (joined) chunks.push(joined);
  };

  units.forEach((unit) => {
    if (current.length && joinedLength(current) + unit.length + 1 > limit) {
      flush();
      current = overlap > 0 ? current.slice(-overlap) : [];
      // The carried-over tail must never be so long that it blocks progress.
      if (current.length && joinedLength(current) + unit.length + 1 > limit) {
        current = [];
      }
    }
    current.push(unit);
  });

  flush();
  return chunks;
}

function chunkTranscript(text, maxLen, overlapLines = 0) {
  const limit = Math.max(1, Number(maxLen) || 3500);
  const overlap = Math.max(0, Number(overlapLines) || 0);
  if (!text || !String(text).trim()) return [];

  const units = [];
  String(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .forEach((line) => {
      if (line.length <= limit) {
        units.push(line);
        return;
      }
      splitLongLine(line, limit).forEach((part) => units.push(part));
    });

  const greedy = pack(units, limit, overlap);
  if (greedy.length < 2) return greedy;

  // Filling each chunk to the brim leaves a runt at the end: the 3658-character
  // sample splits into 3354 + 304, and a 304-character tail is short enough that
  // the model answers it with an empty graph and half the transcript is lost.
  // Find the smallest budget that still needs no more chunks than the greedy pass
  // — that is the split where the largest chunk is as small as it can be.
  let low = Math.ceil(joinedLength(units) / greedy.length);
  let high = limit;
  let best = greedy;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = pack(units, mid, overlap);
    if (candidate.length <= greedy.length) {
      best = candidate;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return best;
}

module.exports = { chunkTranscript, splitLongLine };
