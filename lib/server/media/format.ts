// What the media bytes look like.
//
// The provider answers a feed it has no video for with a placeholder picture:
// the playlist is fine, the segment URL answers 200, the content type even
// says "image/png" — and the payload is a picture, not video. Such a segment
// must never be published as if it were a video, and a door that serves one
// cannot be offered as a server.
//
// MPEG-TS starts with a sync byte every 188 bytes; an ISO base media file
// (fMP4) starts with a box — "ftyp" for the initialisation segment, "moof"
// for the media itself, "styp" for a segment that opens with a type.
//
// And sometimes the video is packed into something else.
//
// A provider that hands out only its own player serves the match as a WebP:
// thirteen bytes of picture, and then an "EXIF" chunk that holds the whole
// transport stream. The content type says "image/webp", the file is a picture
// as far as any player is concerned, and the browser's own player takes the
// stream back out of it before it plays. An app that only asks "is this a
// picture or a video?" throws the match away.
//
// So the container is opened here: the transport stream is taken out of it,
// and what is left is what the player is given.

/** True when the bytes are video a player can play. */
export function looksLikeMedia(head: Buffer): boolean {
  if (head.length < 4) return false;
  if (head[0] === 0x47 && (head.length < 188 || head[188] === 0x47)) return true;
  if (head.length >= 8) {
    const box = head.subarray(4, 8).toString('latin1');
    if (box === 'ftyp' || box === 'moof' || box === 'styp') return true;
  }
  // A container that holds the video inside it.
  return embeddedTransportStream(head) !== null;
}

/**
 * True when a transport stream starts here.
 *
 * Two sync bytes 188 apart are the mark of one; a whole run of them is the
 * proof. The short form is what a peek of the first bytes of a segment can
 * answer, the long form is what the whole segment answers.
 */
function transportStreamAt(body: Buffer, at: number, length: number): boolean {
  if (length < 189) return false;
  if (body[at] !== 0x47 || body[at + 188] !== 0x47) return false;

  const packets = Math.floor(length / 188);
  if (packets < 5) return true;
  let syncs = 0;
  for (let index = 0; index < packets; index += 1) {
    if (body[at + index * 188] === 0x47) syncs += 1;
  }
  return syncs / packets >= 0.98;
}

/** The chunks a WebP file is made of. */
const WEBP_CHUNKS = new Set([
  'VP8 ',
  'VP8L',
  'VP8X',
  'ANIM',
  'ANMF',
  'ALPH',
  'EXIF',
  'XMP ',
  'ICCP',
]);

function chunkName(body: Buffer, at: number): string {
  if (at < 0 || at + 4 > body.length) return '';
  return body.subarray(at, at + 4).toString('latin1');
}

/**
 * The chunk that follows, and where it starts.
 *
 * A chunk is normally padded to an even length - but not always, and a file
 * that does not pad its chunks would be walked into the wrong place if the
 * app assumed it. So the chunk that is really there is looked for, rather
 * than calculated.
 */
function nextChunk(body: Buffer, from: number): number {
  for (const candidate of [from, from + 1]) {
    if (candidate + 8 > body.length) continue;
    if (WEBP_CHUNKS.has(chunkName(body, candidate))) return candidate;
  }
  return -1;
}

/**
 * The transport stream inside a container, when there is one.
 *
 * Only the containers the app has met are opened: a RIFF file whose type is
 * "WEBP", whose chunks are walked one by one. The chunk that holds a
 * transport stream is the one that is taken out.
 */
function embeddedTransportStream(body: Buffer): Buffer | null {
  if (body.length < 12) return null;
  if (body.subarray(0, 4).toString('latin1') !== 'RIFF') return null;
  if (body.subarray(8, 12).toString('latin1') !== 'WEBP') return null;

  let offset = 12;
  for (let guard = 0; guard < 32; guard += 1) {
    if (offset + 8 > body.length) break;
    if (!WEBP_CHUNKS.has(chunkName(body, offset))) break;

    const size = body.readUInt32LE(offset + 4);
    const at = offset + 8;
    if (size <= 0) break;
    const payload = body.subarray(at, Math.min(at + size, body.length));
    if (transportStreamAt(body, at, payload.length)) return payload;

    const next = nextChunk(body, at + size);
    if (next < 0) break;
    offset = next;
  }
  return null;
}

/**
 * The media inside a segment.
 *
 * A segment that is video is returned as it is. A segment that carries its
 * video inside a picture is opened, and the video is returned on its own -
 * because that is what the player is given, and what is written to disk.
 */
export function unwrapMedia(body: Buffer): Buffer {
  return embeddedTransportStream(body) ?? body;
}
