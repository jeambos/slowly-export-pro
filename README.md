# Slowly Export Pro

[Slowly Export Pro](https://greasyfork.org/en/scripts/604685-slowly-export-pro) is a local userscript fork of Slowly Export by HUM4N_F1L3.json. The code is licensed under GPLv3; see [LICENSE](LICENSE).

See [CHANGELOG.md](CHANGELOG.md) for user-facing version changes.

## Install

1. Install a userscript manager such as Tampermonkey or Violentmonkey.
2. Open `Slowly Export Pro.user.js` in the manager, or create a new script and paste its contents.
3. Disable the original Slowly Export script while using this fork, so both scripts do not create export controls.
4. Visit `https://web.slowly.app/`. A separate pill-shaped **Export** button and round gear button appear near the upper right. Both are 48 pixels high; Export uses the same text size and weight as Slowly's Reply action. Drag either button or the settings panel title to move them together. Their position is saved in this browser.

The interface supports English, Simplified Chinese, Traditional Chinese, Japanese, Korean, Spanish, French, German, and Brazilian Portuguese. Dragging either button or the settings title moves the controls as a group; the saved position is local to this browser.

## Export letters

1. Open any letter in a pen-pal conversation. The script detects whether the newer-letter left arrow and older-letter right arrow are available.
2. Open the gear menu to configure the export. **My pen name** starts as `me`; on first run, the script briefly tries to read your profile name from the top-right avatar menu, then stops after repeated failures and asks you to enter the name. This name separates local archives and export history, and is not inserted into exported letters. If you use multiple Slowly accounts, give each one a distinct name here.
3. Choose output format, filename template, and language. Use the localized buttons below the template to insert fields at the cursor, with buttons for separators, deletion, and clearing. Markdown also offers output mode, attachment folders, and Markdown style. HTML offers one of six reading layouts, attachment folders, and an accent color; EPUB offers the accent color. The default filename template is `{date}-{time} ({index}) {author} from {location}`.
4. Click **Export letters** in the gear menu, or click **Export** to start immediately with the saved settings. From a middle letter, **Export** scans to the newest end and reverses to cover the whole conversation. If only one arrow is available, the script follows it to the other end. The gear menu's **Export letters** action still lets you choose how to traverse from a middle letter.

Reversing visits some letters twice and can take a long time. Stopping at the first end exports only the visited segment: its filename indices are relative to that segment and the incremental checkpoint is not advanced. A fresh scan skips letters through the last successful export by default. Select **Export all letters** to include them again. Starting at the newest letter and following the older arrow can stop as soon as it reaches the saved checkpoint. When the current letter is the newest one in a complete local archive and the site has no newer letter, that archive can instead be exported again without scanning the site.

The script uses the letter URL ID to identify the incremental stop. Progress is separate for each letter format; the existing Markdown progress key is preserved. If that ID is no longer present, the script stops and asks you to use **Export all letters**. A download is considered started when the browser receives the generated file; the script cannot independently verify that you saved it. In **Download each letter** mode, it asks you to confirm that all files downloaded before moving the stop point.

The same confirmation appears when the long Markdown and `assets.zip` are downloaded as two separate files.

The `{index}` part of the filename is the chronological letter index within that pen pal's conversation, counting from its oldest letter. The filename template can rearrange or omit `{date}`, `{time}`, `{index}`, `{author}`, and `{location}`; the settings panel shows a preview. If Slowly's displayed date cannot be parsed, the filename says `undated-unknown-time`; inspect those letters manually. An unparseable date also prevents the batch from advancing its export checkpoint.

## Letter formats

| Format | Download | Reading behavior |
| --- | --- | --- |
| Markdown | Existing ZIP, one long `.md` plus `assets.zip`, or direct per-letter downloads | Editable Markdown text |
| HTML | One ZIP containing `index.html` and local assets | Extract the ZIP, then open `index.html` offline |
| EPUB | One `.epub` book with one chapter per letter | Uses the reading app's own contents list and paging; no HTML template selection |
| TXT | One ZIP containing one UTF-8 `.txt` per letter and attachments beside the text | Plain text; attachments are listed by local filename |

HTML layouts are **Classic letter view** (a letter list opening paper-style detail pages with a return-to-list button), **Photo and audio album** (picture thumbnails and voice icons with date, time, and sender captions; each card opens its letter), **Continuous reading** (all letters and a contents list), **Sidebar reader** (one letter at a time, navigation buttons and left/right keys), **Timeline cards** (horizontal browsing and a large reading dialog), and **Stamp gallery** (stamp-centered cards and a reading dialog). The timeline supports touch swipe, mouse drag, and wheel movement over its track. On mobile the dialog fills about 95% of the viewport. The HTML archive contains no remote scripts or styles; extracted assets use local paths. HTML and EPUB use the selected accent color where supported.

The **Preview layout** button beside the HTML layout selector opens a new window using placeholder letters and the current layout and accent color. It does not include your account or letter data. Errors appear at the top of the menu and flash its edge red. The menu is shorter than the page; its title and status stay visible while settings scroll, and Export remains available while it is open.

**Export all letters** includes letters exported before. The gear menu ends with a two-line credit showing the script version, current year, and original author.

The filename template names per-letter Markdown and TXT files and supplies media filename stems inside HTML and EPUB packages. The HTML ZIP and EPUB book use a conversation-based package name.

## Attachments and output

Attachment names use the corresponding Markdown filename stem and keep the original file extension. If a letter has multiple assets, the names add `(1)`, `(2)`, and so on. Layouts are beside Markdown, under `assets/`, or under type folders such as `picture/`, `voice/`, `stamp/`, and `avatar/`.

- **One ZIP, separate letters (Markdown):** Markdown and assets are inside one archive.
- **One long Markdown + assets.zip:** extract `assets.zip` beside the Markdown file to make its relative image links work offline.
- **Download each letter (Markdown):** each Markdown is downloaded separately. With the root layout, assets are also downloaded separately. With either subfolder layout, assets come in `assets.zip` to preserve folders after extraction. Browsers may ask permission for multiple downloads.

TXT assets always sit beside the text files inside the ZIP and use `<letter-stem>-<category>-<number>.<extension>`, numbering each category separately. Each TXT file identifies its stamp and avatar by name, then lists only actual letter media under Attachments. HTML assets follow the selected attachment layout inside the ZIP. EPUB embeds fetched assets in its book container. WAV/OGG voice files and other unsupported media are preserved as files but may require extracting the EPUB to access; playback depends on the reading app.

**Export letter stamps only** scans the selected conversation without applying letter-export progress, then creates a separate ZIP of its stamp images. It does not mark those letters as exported. A full scan can take time; stopping at the first end from a middle letter still exports only that segment.

## Stamp albums

- On the My Stamps page, **Export current stamp album** packages the page's unlocked stamp cards and their available metadata.
- If a Stamp Collection dialog is open anywhere on Slowly Web, the button packages only the images inside that dialog. Empty slots and background page cards are excluded.
- When Stamp Collection is open over a letter, quick **Export** confirms that it will export stamps. The status shows stamp count, then ZIP compression percentage.
- The script tries a larger `stamp/` image for each Collection thumbnail and falls back to its displayed `stamp-sm/` image if needed.
- The `/store` pages are never treated as owned stamp albums.

The archive includes `manifest.json`. Collection dialog HTML does not expose item descriptions or unlock dates, so those fields are empty there.

## Optional local archive

**Keep local letter archive** is off by default for new installations; enable it in the gear menu if you want browser storage. Existing settings keep their saved choice. When enabled, the script saves letter text, metadata, and attachment URLs in IndexedDB. It **does not cache attachment files**. When the currently open letter is the archive's latest letter and the page shows no newer letter, export offers **Use local archive** (focused by default), **Fetch all letters again**, and **Close** (no export). Open another letter to scan the site for newer content. Re-fetch when content is incomplete or attachment downloads failed; attachments download again in either mode. Use **Fill local archive** to read a complete conversation without downloading letters; from a middle letter, choose reverse traversal. A partial traversal does not replace the archive. Restoring a backup replaces the current pen name's local archive after confirmation; it does not restore export progress. A restored complete archive can be reused even when the browser's old progress record is gone. The archive actions are in a collapsed **Archive management** section below the export actions. **View archive status** shows the current pen name's archived letter and pen-pal totals, attachment counts by type, and each pen pal's oldest and newest valid letter dates. Stamps and avatars are separate from letter attachments. Clearing browser site data can erase the archive, so keep downloaded exports and archive backups separately.

The HTML **Classic letter view** keeps up to 300 characters of each letter's body in the generated file and visually clamps list cards to five lines. It builds these previews during export from the full letter body, including for existing local archives.

## Data and download behavior

Export progress is stored in browser local storage under the configured pen name and tracked separately for Markdown, HTML, EPUB, and TXT. The optional letter archive uses IndexedDB for text, metadata, and attachment URLs. Neither browser record is a replacement for the files you download; clearing site data can remove both. A backup restores archive contents but not the per-format export checkpoints.

The script reads letters from Slowly Web and downloads media from the URLs exposed by that page. It does not upload letter contents to a separate service. JSZip 3.10.1 is loaded from jsDelivr through the userscript's `@require` directive to build ZIP files. The HTML export includes local scripts, styles, and downloaded assets so it can be read offline after extraction.

An asset download failure or unparseable letter date flags the batch and leaves its export checkpoint unchanged. For modes that start multiple browser downloads, the script asks you to confirm they have finished before saving progress. It cannot verify that every file was saved by the browser. If progress cannot be written, it reports that the download started but its checkpoint was not saved.

## Development

The source files are in `src/`. Build the installable userscript with:

```powershell
node scripts/build.mjs
```

Check the generated userscript syntax with `node --check 'Slowly Export Pro.user.js'`. The test suite and HTML fixtures are kept locally and are not included in this public repository.

A real logged-in Slowly browser test and an independent EPUB reader check are still needed before relying on a large export, especially for attachments and changes to Slowly's page structure.
