import { Room, RoomEvent, Track } from 'livekit-client';

let room = null;
let mediaStream = null;

chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.mediaStreamId, msg.livekitUrl, msg.livekitToken);
  }

  if (msg.type === 'STOP_CAPTURE') {
    stopCapture();
  }
});

async function startCapture(mediaStreamId, livekitUrl, livekitToken) {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: mediaStreamId,
        maxWidth: 854,
        maxHeight: 480,
        maxFrameRate: 15,
      },
    });

    const videoTrack = mediaStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('No video track from tab capture');

    room = new Room({
      adaptiveStream: false,
      dynacast: false,
    });

    room.on(RoomEvent.Disconnected, () => {
      console.log('[offscreen] Disconnected from LiveKit room');
      chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: 'LiveKit disconnected' });
    });

    await room.connect(livekitUrl, livekitToken);

    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
      simulcast: false,
      videoEncoding: {
        maxBitrate: 1_500_000,
        maxFramerate: 15,
      },
    });

    console.log('[offscreen] Publishing tab capture to LiveKit');
    chrome.runtime.sendMessage({ type: 'CAPTURE_READY' });
  } catch (err) {
    console.error('[offscreen] Capture failed:', err);
    chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: err.message });
  }
}

function stopCapture() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  if (room) {
    room.disconnect();
    room = null;
  }
}
