import { Room, RoomEvent, Track } from 'livekit-client';

let room = null;
let mediaStream = null;
let videoTrack = null;

chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ACQUIRE_TAB_MEDIA') {
    acquireTabMedia(msg.mediaStreamId);
  }

  if (msg.type === 'PUBLISH_TO_LIVEKIT') {
    publishToLivekit(msg.livekitUrl, msg.livekitToken);
  }

  if (msg.type === 'STOP_CAPTURE') {
    stopCapture();
  }
});

async function acquireTabMedia(mediaStreamId) {
  try {
    stopCapture();

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

    videoTrack = mediaStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('No video track from tab capture');

    console.log('[offscreen] Tab media acquired');
    chrome.runtime.sendMessage({ type: 'MEDIA_ACQUIRED' });
  } catch (err) {
    console.error('[offscreen] Tab media failed:', err);
    chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: err.message });
  }
}

async function publishToLivekit(livekitUrl, livekitToken) {
  try {
    if (!videoTrack) throw new Error('No tab video track to publish');

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
    console.error('[offscreen] LiveKit publish failed:', err);
    chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: err.message });
  }
}

function stopCapture() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  videoTrack = null;

  if (room) {
    room.disconnect();
    room = null;
  }
}
