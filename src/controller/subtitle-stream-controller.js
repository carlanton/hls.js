/*
 * Subtitle Stream Controller
*/

import Event from '../events';
import {logger} from '../utils/logger';
import Decrypter from '../crypt/decrypter';
import TaskLoop from '../task-loop';

const State = {
  STOPPED : 'STOPPED',
  IDLE : 'IDLE',
  KEY_LOADING : 'KEY_LOADING',
  FRAG_LOADING : 'FRAG_LOADING'
};

class SubtitleStreamController extends TaskLoop {

  constructor(hls) {
    super(hls,
      Event.MEDIA_ATTACHED,
      Event.ERROR,
      Event.KEY_LOADED,
      Event.FRAG_LOADED,
      Event.SUBTITLE_TRACKS_UPDATED,
      Event.SUBTITLE_TRACK_SWITCH,
      Event.SUBTITLE_TRACK_LOADED,
      Event.SUBTITLE_FRAG_PROCESSED);

    this.config = hls.config;
    this.vttFragSNsProcessed = {};
    this.vttFragQueues = undefined;
    this.currentlyProcessing = null;
    this.state = State.STOPPED;
    this.currentTrackId = -1;
    this.decrypter = new Decrypter(hls.observer, hls.config);
    this.media = null;
  }

  onHandlerDestroyed() {
    this.state = State.STOPPED;
  }

  // Remove all queued items and create a new, empty queue for each track.
  clearVttFragQueues() {
    this.vttFragQueues = {};
    this.tracks.forEach(track => {
      this.vttFragQueues[track.id] = [];
    });
  }

  // If no frag is being processed and queue isn't empty, initiate processing of next frag in line.
  nextFrag() {
    if(this.currentlyProcessing === null && this.currentTrackId > -1 && this.vttFragQueues[this.currentTrackId].length) {
      let frag = this.currentlyProcessing = this.vttFragQueues[this.currentTrackId].shift();
      this.fragCurrent = frag;
      this.hls.trigger(Event.FRAG_LOADING, {frag: frag});
      this.state = State.FRAG_LOADING;
    }
  }

  // When fragment has finished processing, add sn to list of completed if successful.
  onSubtitleFragProcessed(data) {
    if(data.success) {
      this.vttFragSNsProcessed[data.frag.trackId].push(data.frag.sn);
    }
    this.currentlyProcessing = null;
    this.state = State.IDLE;
    this.nextFrag();
  }

  onMediaAttached(data) {
    this.media = data.media;
    this.state = State.IDLE;
  }

  // If something goes wrong, procede to next frag, if we were processing one.
  onError(data) {
    let frag = data.frag;
    // don't handle frag error not related to subtitle fragment
    if (frag && frag.type !== 'subtitle') {
      return;
    }
    if(this.currentlyProcessing) {
      this.currentlyProcessing = null;
      this.nextFrag();
    }
  }

  doTick() {
    switch(this.state) {
      case State.IDLE:

        // exit if tracks don't exist
        if (!this.tracks) {
          break;
        }

        const currentFragSN = Boolean(this.currentlyProcessing) ? this.currentlyProcessing.sn : -1;

        let trackDetails;
        if (this.currentTrackId < this.tracks.length) {
          trackDetails = this.tracks[this.currentTrackId].details;
        }

        if (typeof trackDetails === 'undefined') {
          break;
        }

        // Prevents too many simultaneous downloads.
        const reducedFragments = this.getFragmentsBasedOnMaxBufferLength(trackDetails.fragments);

        // Add all fragments that haven't been, aren't currently being and aren't waiting to be processed, to queue.

        reducedFragments.forEach(frag => {
          if(!(this.isAlreadyProcessed(frag) || frag.sn === currentFragSN || this.isAlreadyInQueue(frag))) {
            // Load key if subtitles are encrypted
            if ((frag.decryptdata && frag.decryptdata.uri != null) && (frag.decryptdata.key == null)) {
              logger.log(`Loading key for ${frag.sn}`);
              this.state = State.KEY_LOADING;
              this.hls.trigger(Event.KEY_LOADING, {frag: frag});
            } else {
              // Frags don't know their subtitle track ID, so let's just add that...
              frag.trackId = this.currentTrackId;
              this.vttFragQueues[this.currentTrackId].push(frag);

              this.nextFrag();
            }
          }
        });
      }
  }

  /**
   * If you enter a live broadcast with time shift enabled (or scrub an on demand video),
   * the size of the fragment list might be huge. This function takes the current time and max buffer length into account
   * when deciding which fragments to be downloaded.
   *
   * [ . . . . . . . . . . . . . . . . .] // List of fragments (may as well be thousands)
   *                     |                // Current time
   *                   [ . . . . . ]      // Fragments to be downloaded if max buffer length is 5.
   *
   * @param fragments
   * @returns {Array} reduced fragments
   */
  getFragmentsBasedOnMaxBufferLength(fragments = []) {
    if (!this.config.maxBufferLength) {
      return fragments;
    }

    // Find the lowest fragment index based on current time
    const lowerIndex = fragments.findIndex((fragment) => fragment.start >= this.media.currentTime);

    // Find the upper fragment index based on lower index and max buffer length
    const upperIndex = Math.min(fragments.length - 1, (lowerIndex + this.config.maxBufferLength));

    return fragments.filter((fragment, index) => index >= lowerIndex && index <= upperIndex);
  }

  isAlreadyProcessed(frag) {
    return this.vttFragSNsProcessed[this.currentTrackId].indexOf(frag.sn) > -1;
  }

  isAlreadyInQueue(frag) {
    return this.vttFragQueues[this.currentTrackId].some(
      (fragInQueue) => fragInQueue.sn === frag.sn
    );
  }

  // Got all new subtitle tracks.
  onSubtitleTracksUpdated(data) {
    logger.log('subtitle tracks updated');
    this.tracks = data.subtitleTracks;
    this.clearVttFragQueues();
    this.vttFragSNsProcessed = {};
    this.tracks.forEach(track => {
      this.vttFragSNsProcessed[track.id] = [];
    });
  }

  onSubtitleTrackSwitch(data) {
    this.currentTrackId = data.id;
    this.clearVttFragQueues();
  }

  // Got a new set of subtitle fragments.
  onSubtitleTrackLoaded() {
    this.tick();
  }

  onKeyLoaded() {
    if (this.state === State.KEY_LOADING) {
      this.state = State.IDLE;
      this.clearInterval();

      this.tick();

      return;
    }

    const noOfFragments = this.tracks[this.currentTrackId].details.fragments.length;
    const noOfProcessed = this.vttFragSNsProcessed[this.currentTrackId].length;
    const noOfQueued = this.vttFragQueues[this.currentTrackId].length;

    if ((noOfProcessed + noOfQueued) < noOfFragments) { // Check if there are unhandled fragments

      // TODO This should be cleared on pause, error etc.
      this.setInterval(1000);

      return;
    }

    this.clearInterval();
  }

  onFragLoaded(data) {
    var fragCurrent = this.fragCurrent,
        decryptData = data.frag.decryptdata;
    let fragLoaded = data.frag,
        hls = this.hls;
    if (this.state === State.FRAG_LOADING &&
        fragCurrent &&
        data.frag.type === 'subtitle' &&
        fragCurrent.sn === data.frag.sn) {
          // check to see if the payload needs to be decrypted
          if ((data.payload.byteLength > 0) && (decryptData != null) && (decryptData.key != null) && (decryptData.method === 'AES-128')) {
            var startTime;
            try {
              startTime = performance.now();
            } catch (error) {
              startTime = Date.now();
            }
            // decrypt the subtitles
            this.decrypter.decrypt(data.payload, decryptData.key.buffer, decryptData.iv.buffer, function(decryptedData) {
              var endTime;
              try {
                endTime = performance.now();
              } catch (error) {
                endTime = Date.now();
              }
              hls.trigger(Event.FRAG_DECRYPTED, { frag: fragLoaded, payload : decryptedData, stats: { tstart: startTime, tdecrypt: endTime } });
            });
          }
        }
  }
}
export default SubtitleStreamController;
