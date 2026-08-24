# music/

The game's built-in soundtrack. Every file here is picked up automatically and
listed in **Settings → Background Music** alongside anything you upload.

These three are generated, not recorded — `node tools/generateMusic.mjs`
(or `npm run music`) re-renders them from the synthesizer in that file.
Drop your own MP3 or WAV in this folder and it joins the list on the next
reload; the leading number just controls where it sorts.
