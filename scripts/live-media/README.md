# Live check of Matrix call media

`npm run live:media` runs a real encrypted Matrix call between Multicord's own
call view and an Element-style peer, through real servers in Docker, and checks
that sound and video get through both ways. It prints a result table, tears
everything down (also on failure or Ctrl-C) and exits with 1 when any check
fails. It is not part of `npm run check` or CI: it needs Docker and a desktop.

## Prerequisites

- Docker running (Docker Desktop on Windows and macOS). The first run pulls
  `matrixdotorg/synapse`, `livekit/livekit-server` and
  `ghcr.io/element-hq/lk-jwt-service` at pinned versions (see `stack.mjs`;
  override with `MC_MEDIA_SYNAPSE_IMAGE`, `MC_MEDIA_LIVEKIT_IMAGE`, `MC_MEDIA_JWT_IMAGE`).
- `npm ci` done; a desktop session (two Electron windows open while it runs).
- Free ports on 127.0.0.1: 27880-27882 (LiveKit, TCP and UDP), 28008 (Synapse),
  28080 (lk-jwt-service), 28443 (TLS proxy), 28490 (Element page), 29301 and
  29302 (DevTools). They stay clear of the other live suites' stacks.
- About 2 GB of free memory.

## Run

```
npm run live:media                       # both call formats, about 3-4 minutes
npm run live:media -- --format sticky    # one format: legacy or sticky
npm run live:media -- --no-build         # reuse dist/ as it is
npm run live:media -- --verbose          # also matrix-js-sdk's and the build's output
npm run live:media -- --json result.json # the result rows as JSON too
```

`node scripts/live-media/run.mjs` takes the same options.

## What it does

1. Makes a temporary folder (`mc-media-*` in the system temp folder) with fresh
   secrets (registration secret, LiveKit key, application service tokens,
   Synapse signing key) and throwaway self-signed certificates (made with the
   Synapse image's Python, so no OpenSSL is needed). Nothing secret is checked in.
2. Starts `mc-media-hs` (Synapse with sticky events, MSC4143/MSC4195 call
   transports and lk-jwt-service as application service), `mc-media-lk`
   (LiveKit) and `mc-media-jwt` (lk-jwt-service) on a `mc-media` network.
3. Builds Multicord (`scripts/build.mjs`) and bundles the Element page
   (`element/page.ts`: livekit-client with its E2EE worker and a key provider
   like Element Call's).
4. Starts two scratch Electrons, each with its own `--user-data-dir` in the
   temporary folder (never the real `%APPDATA%\Multicord` profile):
   - Multicord from this checkout, with only a Matrix account on
     `https://hs.mcmedia.test`. Only this instance gets `--proxy-server` (the
     TLS proxy in `proxy.mjs`), `--host-resolver-rules` and
     `--ignore-certificate-errors`; the app's code is unchanged. A fake
     microphone plays 440 Hz.
   - "Element": `element/main.cjs` showing the media page; a fake microphone
     plays 880 Hz. Its Matrix side (matrix-js-sdk MatrixRTC with Rust crypto)
     runs in `run.mjs` and hands the media keys to the page.
5. Signs Multicord in, and restarts it once: Multicord fixes the hosts it may
   reach when it starts, so the homeserver's LiveKit server, learned at sign-in,
   is allowed from the next start (the app tells users the same).
6. For each format (the `org.matrix.msc3401.call.member` state event, then the
   sticky `m.rtc.member` that Element Call's "Matrix 2.0" mode sends), in a
   fresh encrypted room and a fresh Multicord process (it restarts before the
   second format):
   - **audio**: LiveKit's `ListParticipants` shows both publishing MICROPHONE
     with encryption GCM; Multicord's LiveKit identity shows the format it
     joined in; Element hears 440 Hz from Multicord and Multicord hears 880 Hz
     from Element, louder than -50 dBFS, measured on the decoded remote audio.
   - **video**: both turn the camera on; LiveKit shows both CAMERA tracks GCM
     and unmuted; the frames decoded from the other side keep increasing on
     both sides; the tones still get through.
   - **rotation**: a third device joins the call: both rotate their media key
     (as Element's MatrixRTC sees it) and the tones still get through; it
     leaves: both rotate again, and the tones still get through.
   - **negative**: Element sends under a key Multicord never got and holds a
     wrong key for Multicord: both sides hear silence (below -70 dBFS) and
     Element reports decrypt errors. This shows the checks above can fail.
7. Prints the table, removes the containers, the network, both Electrons (by
   their own process ids; on Windows also by a CIM query for this run's
   temporary folder name in their command line, never by process name) and
   the folder, and checks that nothing is left.

## What it does not cover

Screen sharing, TURN or any relay (LiveKit is reached directly on 127.0.0.1),
mute and deafen, device switching, push to talk, calls ringing, more than two
media participants, real microphones and cameras, Element Call itself (the peer
is its media layer and MatrixRTC, not its UI), matrix.org, and network loss.

## Video and Chromium's fake camera

Both Electrons film with Chromium's fake camera. On Windows, once a page has
a peer connection, Chromium asks for the camera's frames in GPU memory
buffers, and in that mode its video capture service process crashed about a
second into 3 of 14 captures in a bare Electron page (Electron 44), and in 2
of 4 runs of this check. The crash ends that camera, and Chromium, listing
the devices again while the service is down, keeps an empty list for the rest
of the process: LiveKit then mutes that side's camera (the other side sees no
frames), and the next call's camera cannot start ("Requested device not
found"). Multicord's own code is not involved.

So the runner starts both Electrons with
`--disable-video-capture-use-gpu-memory-buffer` (frames in shared memory: no
crash in 15 captures, against 3 in 14 without it), restarts Multicord before
each format so a crash cannot carry over into the next call, and logs
Chromium's warnings. If a video row still fails, its detail says whether the
capture service crashed in either process since the cameras went on, and
shows both sides' WebRTC video statistics, tracks and listed cameras.

The switch is backed by the bare-page probe only: no full run of this check
has finished with it yet, so whether video now passes every time is not known.

## Platform notes

Written for and run on Windows. The parts that are Windows-only:
- the extra clean-up and the final "nothing left" check by CIM query
  (`processes.mjs`); elsewhere Electron runs in its own process group, which is
  killed as a whole;
- waiting for the profile's `Local State` to hold safeStorage's key before the
  restart (elsewhere the key lives in the OS keychain);
- `--disable-features=CalculateNativeWinOcclusion` and
  `--disable-video-capture-use-gpu-memory-buffer` (harmless elsewhere).

On Linux and macOS it should work as is (Synapse runs as the host user so it
can write the mounted folder), but it has not been run there.

## Files

- `run.mjs`: the runner (set-up, sign-in, table, teardown, exit code)
- `scenario.mjs`: one call in one format, and its checks
- `stack.mjs`: the Docker containers; `config/`: their config templates and the certificate script
- `proxy.mjs`: the TLS proxy for the scratch Multicord
- `processes.mjs`: starting and stopping the scratch Electrons
- `cdp.mjs`: DevTools evaluation
- `element/`: the Element side's Electron main and media page
