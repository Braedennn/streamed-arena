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

/** True when the bytes are video a player can play. */
export function looksLikeMedia(head: Buffer): boolean {
  if (head.length < 4) return false;
  if (head[0] === 0x47 && (head.length < 188 || head[188] === 0x47)) return true;
  if (head.length >= 8) {
    const box = head.subarray(4, 8).toString('latin1');
    if (box === 'ftyp' || box === 'moof' || box === 'styp') return true;
  }
  return false;
}
