/*!
 * cleanup-panel.js  -  the "Audio cleanup" side panel for the Video Redline tool.
 *
 * Plain ES2019, no modules, no libraries, no network, no DOM access at load time. It builds the whole panel inside a host
 * element and talks to the page only through the api object given to create(). Styles are injected from a CSS string
 * (every class is prefixed cp-). All transcript / user text is put in the page with textContent only.
 *
 *   var panel = CleanupPanel.create({ host: el, api: api, Cleanup: Cleanup });
 *   panel.load(textOrObject)   open a transcript (canonical JSON, Whisper-style JSON, SRT or VTT). Returns
 *                              { ok:true, candidates, applied, pending, warnings } or { ok:false, error }
 *   panel.clear(opts)          forget the transcript. opts.removeCuts:true also removes the cuts made from it
 *   panel.hasTranscript()      true when a transcript is loaded
 *   panel.refreshMarkers()     call whenever the page's cuts change (added, removed, restored). Repaints the transcript
 *                              strike-through and the lists. An automatic cut that the user deleted in the page (or that page
 *                              undo took away) counts as rejected. An accepted cut that goes away puts its card back under
 *                              "Needs your decision" - unless the settings would apply that card on their own (or the card is not
 *                              there, say its kind is switched off): then the card is recorded as Rejected instead, one click on
 *                              Restore (exactly what happens is under "Cuts that appear or vanish" below). A cut that comes back
 *                              (page redo / undo, a loaded session) is kept. With the page and the panel in agreement it makes no
 *                              api.addCut / api.removeCut call, and following the page never adds or takes out a cut (only the
 *                              loaded call below adds some). Also re-reads api.getFile() for the "Create transcript" card.
 *   panel.refreshMarkers({ loaded: true })
 *                              the same call with one option, for the host to make ONCE, right after the user loaded a session
 *                              (File > Load session) and never elsewhere. Make it instead of the plain call that follows a load:
 *                              after a plain call the Rejects are already recorded and count as the user's. A session replaces
 *                              all of the page's cuts, so an automatic cut of this transcript that it lacks was not deleted by
 *                              the user (and the Rejects are not in the session file): it is not recorded as Rejected. The cards
 *                              that are applied on their own and have no cut get it back through api.addCut, all in one api.batch
 *                              (one step in the page's undo history), and a toast says how many ("Audio cleanup added 3 automatic
 *                              cuts that the session did not have."). See "Cuts that appear or vanish" below for what stays as
 *                              it is. Any other argument, or an object without loaded: true, is ignored: the call is then
 *                              exactly a plain refreshMarkers().
 *   panel.summary()            { total, applied, pending, accepted, rejected, manual, savesSeconds,
 *                                appliedSeconds, pendingSeconds, level }
 *                              (the last three are optional additions: seconds covered by the cuts applied on their own
 *                              and by the cuts that wait for a decision; level = the chosen cleanup level id, only present
 *                              when the engine has Cleanup.LEVELS)
 *   panel.wordsBetween(t0, t1) optional addition, for export. The transcript words said in [t0, t1] (seconds): a word counts
 *                              when at least half of it is inside the range (the last word of the sentence before a marker, and
 *                              the first of the next one, only overlap it by a frame or two and are left out; a word that just
 *                              touches an edge is out; a single point, t0 == t1, gets the word it falls in). Joined
 *                              with single spaces, no leading / trailing space, at most 1,200 characters (longer text is cut
 *                              at a word and ends with an ellipsis). "" when no transcript is loaded, the times are not
 *                              numbers, or the range holds no words (a pause). Pure, and fast for 8,000 words (binary search
 *                              on a sorted index built once per transcript).
 *   panel.destroy()            remove the panel, listeners and timers. A transcript job that is still running is cancelled
 *
 * options for create() (all optional except host, api and Cleanup):
 *   TranscriberClient   the helper client ({ create(cfg) -> client, helpText(code) }). When missing, the global
 *                       TranscriberClient (if the page loaded transcriber-client.js) is used. With neither, the "Create
 *                       transcript" card only offers the transcript-file path and says the helper is not part of this build.
 *   transcriberPorts    list of ports for TranscriberClient.create (default 47831 to 47835)
 *
 * api (provided by the page):
 *   getDuration() getFps() getTime() seek(t) playRange(t0,t1) onTime(cb)->unsubscribe
 *   addCut({start,end,comment,origin})->markerId  removeCut(markerId)  getCuts()->[{id,start,end,comment,origin}]
 *   toast(msg) storage:{get(key),set(key,value)} confirm(msg)->boolean
 *   optional: pickTranscript() (the page shows its own file picker and calls panel.load), batch(fn) (wrap many addCut /
 *   removeCut calls in one page update; every bulk action in the queue uses exactly one batch call), getVideoName()->string
 *   (the name of the open video), getFile()->File|null (the open video file, for "Create transcript and find cuts"; without
 *   it, or when it returns null, that button is disabled and says "Open a video first"). Without pickTranscript the panel
 *   uses its own hidden file input.
 *   origin = { kind, confidence, auto, candidateId, reason, by:'cleanup-panel' }. Cuts the panel made are recognised by
 *   origin.by or origin.candidateId, and also by marker id + times remembered in storage.
 *
 * Cleanup level: when the engine has Cleanup.LEVELS (Careful / Balanced / Thorough) the Settings area starts with the question
 * "How much should I do on my own?" and ONE compact segmented control (Careful | Balanced | Thorough; real radio buttons, so the
 * arrow keys work) with a single help line under it that shows the help text of the chosen level only. The default is Balanced. The choice is
 * stored as settings.level and passed to Cleanup.analyze as params.level. Only the settings the panel shows are passed to
 * analyze (not a copy of Cleanup.DEFAULTS), so the level's own defaults apply; the "Apply automatically when confidence is at
 * least" box follows the level (Cleanup.PRESETS[level].autoThreshold) until the user types a value of their own
 * (settings.autoPctSet). Changing the level runs the analysis again, keeps the Accept / Reject decisions (matched by kind and
 * overlap, like every other setting) and shows a one-line note such as "Balanced: 113 applied on their own, 182 need you."
 * A saved settings record without level loads as Balanced. With an engine that has no LEVELS the control is hidden and nothing
 * else changes. The numeric settings, the on/off switches and the word list sit under an "Advanced" fold, closed by default.
 *
 * Where Settings sits: it is open only while no transcript is loaded. With a transcript it is ONE line that still names the level
 * ("Cleanup level: Balanced - change"), so the queue and its filter chips are near the top; the line opens everything (the level, and
 * the Advanced fold, which keeps its own remembered state). Opening, restoring or removing a transcript puts Settings back to that
 * automatic state; what the user chose by clicking the line is not stored. In the header, the "Engines" line is one line (cut with an
 * ellipsis) with a "details" button that shows all of it.
 *
 * The queue ("Needs your decision"): a row of filter chips (All, Pauses, Ums and ers, Repeats and stutters, False starts,
 * Sounds; only those that have cards, each with its count) filters the cards. Under the chips, "Accept all N" and "Reject all N"
 * act on exactly the cards in the current filter, ask api.confirm first ("Accept all 54 pauses? That removes 3:12 from the
 * video.") and are one api.batch call and one Z step. J / K / A / R / Space / Z work on the cards of the current filter. With
 * more than 60 undecided cards a one-line tip points at the filters. The default order is by time.
 * Keyboard moves (J / K, Z, the card after A or R, the first card after a file was opened) keep the highlighted card in view inside
 * the panel by changing the panel's own scrollTop; the page is never scrolled. When the last card is decided with a bulk button the
 * keyboard moves to the panel itself (not left on the hidden, disabled button), so Z keeps working, and the key hint stays while there
 * is something to undo. The toast after a bulk action says how many cuts the page really took ("Accepted 46 of 69.") and ends with
 * "Press Z to undo."
 *
 * Create a transcript: with no transcript loaded (and from "Make a new transcript" in the header when one is loaded) the top of
 * the panel shows the card "Clean up this video" with the button "Create transcript and find cuts" and the link "I already
 * have a transcript file". The button needs api.getFile() and a TranscriberClient (see options). It calls client.check(); with no
 * helper (or not ready / busy) an inline card with numbered plain-language steps (TranscriberClient.helpText(code) when
 * present) and "Check again" appears, never an error dialog. With a ready helper it calls client.run(file, {}, onProgress) and
 * shows a determinate progress bar, a stage line, the time left when the helper gives one, and Cancel. The finished transcript
 * goes through the same code path as panel.load(object), so the confident cuts are applied at once, and the card ends with
 * "Found N cuts: M applied on their own, K need you. Saves m:ss." Errors show one calm paragraph (the error's .message plus
 * what to do next). One run at a time; the rest of the panel stays usable; destroy() cancels a running job; a job leaves nothing
 * in storage until it has finished.
 * What the client may send, all optional: check() result { checking:true } (the helper has only just started and is still looking at its
 * speech tools: the card says "Wait a few seconds." / "Then press Check again." and nothing about running setup), result.help (advice of
 * its own for the help card); run() error { help } (advice that fits the real cause: preferred over TranscriberClient.helpText(code) in
 * errors and in the help card; for a job the helper stopped itself it replaces "Cancelled"), error.checking. While the help card shows,
 * its only button is "Check again", so a step that says to click "Create transcript" again is shown as "press Check again"; a first step
 * that only repeats the lead sentence is dropped. With no video open the main button is disabled and says "Open a video first", the same
 * reason is written under it as normal text ("Check again" is disabled the same way), and a click that still gets through says so. The
 * stage line names what the helper does ("Getting ready...", "Reading the sound from your video...", "Putting the cuts together...").
 * Opening another transcript removes the old "Found N cuts" line from the card.
 *
 * Saved transcript and the video it belongs to: when a transcript is opened the panel remembers, with it, the length (and
 * name, when api.getVideoName exists) of the video that was open. At start-up a saved transcript is only applied when that
 * video still matches (length within max(2 s, 2 %), same name when both are known). Otherwise it is kept on hold, with a
 * one-line note and the choices "Use it anyway" / "Forget it", and NO cut is made until the user chooses. A transcript the
 * user opens with panel.load() is always applied (it still shows the "check that it belongs to this video" note). When
 * the page cannot tell the length of its video yet (getDuration() is 0) the check cannot be made and the saved transcript is
 * restored as before, so create the panel once the video's length is known.
 * Decisions are stored with an identity of the transcript (video name and length, word count, first and last word time), so
 * opening the same file again after a reload keeps them.
 *
 * Keyboard (when focus is anywhere inside the panel and you are not typing in a box):
 *   J next card   K previous card   A accept   R reject   Space preview (card, or the selected words when the
 *   transcript has focus)   Z undo the last decision   X cut the selected words   Esc clear the selection
 *
 * Storage keys (strings, through api.storage): vrt:cleanup:transcript  vrt:cleanup:settings  vrt:cleanup:decisions
 *   vrt:cleanup:links  vrt:cleanup:ui
 *   Optional fields added in 1.1.0 (older records without them still load):
 *     vrt:cleanup:settings   level ('careful' | 'balanced' | 'thorough', default 'balanced'), autoPctSet (true when the user
 *                            typed their own confidence limit; otherwise autoPct simply follows the level)
 *     vrt:cleanup:transcript source ({ kind:'helper' } for a transcript made by the helper, shown in the header as "Made by
 *                            the helper on this computer"; { kind:'file', name } for a file opened with the panel's button)
 *     vrt:cleanup:ui         advanced (the "Advanced" fold is open); uiv 4 (the Settings state is no longer stored: it is open while no
 *                            transcript is loaded and one line after that; older records with settings are read and ignored)
 *   Version 1.1.1 changed no public member: only these optional behaviours above (and util.helpCard / pressCheckAgain / repeatsLead).
 *
 * Cuts that appear or vanish behind the panel's back (page undo / redo, loading a session, lost storage; version 1.1.2). The page
 * only calls refreshMarkers(); the panel works out the rest and keeps this promise: when the page already agrees with the panel,
 * refreshMarkers() makes no api.addCut / api.removeCut call at all (so no step is added to the page's undo history), and calling
 * it twice in a row changes nothing the second time.
 *   - A cut the user accepted (origin.by 'cleanup-panel', origin.auto false) that is back in the page without a stored Accept
 *     (page redo, page undo of the panel's own Z, a session loaded into a browser with no saved decisions) is kept and the
 *     Accept is written again. Which card a returned cut speaks for is decided by the SAME rule that decides which cut the panel adds
 *     or takes out (the cut's own card id, else the same kind starting within 50 ms or a frame and a half, else the ranges overlapping by
 *     half, else the card the panel tied the cut to): a cut that fits no card by it is taken on for no card. (Before round 4 a cut that
 *     started 0.1 s from a card was taken on for it although the panel could not pair them, so it added a second cut for that card:
 *     page undo after opening a different transcript added or removed a cut, which cut off the page's redo and stopped its undo.)
 *   - An accepted cut that vanishes (page undo of an Accept, or the user deleting it) has one of two outcomes, by what the settings
 *     would do with its card on their own. A card the settings do NOT apply on their own goes back under "Needs your decision" (its Accept
 *     is dropped). A card they WOULD apply on their own (an Accept given at Careful, the panel now at Balanced, say) is recorded as
 *     Rejected instead (one click on Restore): back under "Needs your decision" it would be applied again at once, and making that cut is
 *     a new step in the page's history. The same goes for an accepted cut whose card cannot be found by the id the cut carries (the card
 *     moved because a setting changed, or its kind is switched off): its range is recorded as Rejected. Every vanished automatic cut is
 *     recorded as rejected. Except an automatic cut that the page swapped for another one of the same card (a loaded session gives every
 *     cut a new id; page undo of a change of "Leave a pause of" puts the cuts of the old pauses back): that is no deletion, so nothing
 *     is rejected. When a swap leaves some other cuts out, those are rejected as before, and a toast says how many and where to find them.
 *   - A plain refreshMarkers() adds and takes out no cut at all. The rules in this list leave nothing to do for it; should a state they did
 *     not think of still leave something (a card that should have a cut and has none, a cut that should not be there), the page is right and
 *     the panel follows it: the card is recorded as taken away (Rejected, or back to waiting when it was accepted and the settings do not
 *     apply it on their own), and the cut stays until the user's next action in the panel. Only the loaded call below adds cuts.
 *   - A Reject is not forgotten by walking the page's history over a moment when the card had a cut. When a cut comes back onto a Rejected
 *     card (page undo of the Reject: the accepted cut of the Accept, or an automatic cut; Z of a Reject: the Accept) the Reject gives way
 *     to it, but is kept aside; when that cut goes away again (page redo to the Reject, or page undo past the Accept) the card is Rejected
 *     again, instead of waiting for a decision as if the user had never rejected it. The page cannot tell "undo of the Accept" from
 *     "redo of the Reject" (the page has no cut on the card in both), and the Reject is what the user last said about the card. What is
 *     kept aside is the Reject as it was recorded (a wide Reject over two cards comes back wide, and a card that merged two cards, say
 *     after a larger minimum gap, gives up all its Rejects to a cut that comes back and gets them all back). Only a Reject of the user's
 *     is kept: one the panel wrote itself while it followed the page (a cut went away, so the card was recorded as taken away) is not
 *     the user's, and a cut that comes back over it simply replaces it. Anything the user does in the panel (a decision, Z, a setting,
 *     opening a transcript) drops what was kept aside, and makes the Rejects the panel wrote itself the card's decision; nothing of it
 *     is stored.
 *   - The panel only ever removes automatic cuts it knows it made. An automatic cut that fits no card and that the panel never
 *     knew (a session made from another transcript) is left alone. So is one that sits on a card which needs a decision (page
 *     undo after a change of level or confidence limit, a session saved under other settings): taking it out would be a new step
 *     in the page's history and page undo would never get past it. Reject takes such a cut out; Accept replaces it, in the same
 *     step, by a cut that records the Accept (the page keeps who made a cut, so page undo, redo, a loaded session and Z then treat
 *     the Accept like any other), and the Z of that Accept puts the cut that was there back (and takes the Accept's cut away: it has
 *     the card's id, not the id of the cut it replaced). The new cut keeps the old one's range and note: only who made it changes.
 *     The exception is a cut that fits its card by overlap alone (the card moved, because "Leave a pause of" or the minimum gap was
 *     different when the cut was made) and shows no edit of the user's, no note other than the ones the panel writes itself: it has the
 *     range of those other settings, not that of the card the user looked at, so the Accept makes the card's own cut.
 *     While following the page the panel also leaves alone such a cut on a card the user rejected, a cut that fits its card
 *     only by overlap (the card moved) and a further cut on a card that already has its own (the other half of two cards that merged, or
 *     two cuts of another transcript lying in one long pause), also when the panel made that cut itself; an action of the user's own changes them as before (a Reject takes a second cut off
 *     its card too, or the next refresh would read it as a returned cut and undo the Reject), and so does a change of a setting
 *     (the page is made to match the new settings). With no transcript the panel claims no cut it did not know, so a session loaded
 *     before the transcript and one loaded after it end up the same.
 *   - Opening a transcript when the panel had none (a loaded session, lost storage) keeps the cuts that are there, and an accepted
 *     cut whose card has moved (other settings) stays accepted, at the range the user gave it (a cut of the user's is not replaced by the
 *     card's own range unless a setting is changed). It asks nothing, except once when most of those cuts fit no card of
 *     the transcript (they were made for another one): OK opens it and keeps them, Cancel changes nothing and does not open it.
 *     A saved transcript that waits for another video ("Use it anyway") is not an old transcript and never causes a question.
 *   - A decision saved by panel 1.0.0 (no end time) finds the card of its kind that starts within 0.15 s of it; when two such
 *     decisions and two cards are close together each decision keeps its own card (the nearest pairs, as many as possible). An Accept
 *     farther away than that finds its card through the cut the old panel made for it (the card the cut overlaps). The end time is filled
 *     in and saved; a decision that no card of any level is near any more can never match and is dropped. The accepted cut itself stays
 *     where the old panel put it (the next engine moves false starts, repeats and stutters by 70-90 ms; the cut is the user's, and one that
 *     fits its card by overlap, or that the Accept ties to the card, is not moved or doubled), and so it does after later decisions and
 *     after a change of a setting that leaves its card the same card (the level, the confidence limit). A setting that gives the card
 *     another place (another id) replaces the cut by the card's own range, as it does for every accepted cut.
 *   - One Uncut over several cuts, and the Z that takes it back, are each one api.batch call.
 *   - Z gives back exactly the cuts a step took out when they were not the plain cut of their card: a cut the user trimmed or wrote
 *     a note on, an automatic cut that sat on a card waiting for a decision. A cut that the page already has again (page undo, a
 *     loaded session) is not added a second time; Z then says it could not undo. A cut whose card no longer keeps it (the page's undo
 *     and redo took the Accept away meanwhile) is not made again only to be taken out; a cut the page refuses to take back is not made
 *     either. Z says how many it could not put back, and why: it never says "Undone" alone when the page ends up different.
 *   - A question about "the cuts made from" the transcript (opening a different one, making a new one, Remove) counts and removes only
 *     the cuts the panel made for it, never those of a loaded session that fit none of its cards, and a cut that carries the id of a
 *     card of the transcript being opened stays (unless the old transcript has a card with that id too, as the leading pause does).
 *     A cut the panel leaves alone on a card that waits for a decision (page undo of a change of level) is the transcript's own when
 *     it carries the id of one of its cards at any level: it is counted and removed with the others, and "Undo all automatic cuts"
 *     rejects those cards. With only the decisions in storage (nothing to tell the panel's cuts by) the question about cuts that
 *     do not fit the new transcript is asked instead. A transcript the helper has just made is never questioned after the wait. The
 *     number in the question for opening a different transcript is what the open takes out, also the further automatic cut on a card
 *     that two cuts carry the id of (a loaded session of the new transcript lies over the old one's cuts): the open removes it in the
 *     same step.
 *   - The help card puts Windows and a Mac in ONE step ("Start the helper. On Windows, ... On a Mac: ..."): splitSteps keeps a
 *     sentence that begins "On a Mac" with the sentence before it.
 *   - refreshMarkers({ loaded: true }), the host's call right after File > Load session, made instead of the plain call that follows a
 *     load (an optional argument, added without a new version: plain calls are exactly as before). It changes ONE thing: an automatic cut of this transcript that the panel made
 *     and that the session lacks is not recorded as Rejected, so its card stays applied on its own and gets the cut back (see above;
 *     one api.batch, one toast with the number). Everything else is as in a plain call: a card the user rejected on this computer
 *     stays rejected (a stored Reject), accepted cuts and the cuts the session carries are taken on (an accepted cut of the session
 *     is the card's Accept also when the card is applied on its own here, say a session made at Careful loaded at Balanced),
 *     waiting cards stay waiting, and strays are left alone. An accepted cut that the session lacks is handled exactly as in a plain call
 *     (see above): the session wins and its Accept is dropped, so a card the settings do not apply on their own goes back under "Needs your
 *     decision"; but a card they would apply on their own is recorded as Rejected, without a toast (the loaded call gives back only the
 *     AUTOMATIC cuts the session lacks, never an accepted one). It is a plain call when no transcript is open, when most of the page's panel cuts fit no card of
 *     the transcript (more than half, the measure of the question when a transcript is opened: a session of another transcript),
 *     and when the session lacks none of the panel's automatic cuts; a second call right away changes nothing and makes no page
 *     call. A cut the page refuses is listed under "Needs your decision" as always. Called from inside one of the panel's own page
 *     calls, like any refreshMarkers(), it does nothing.
 *   No public member was added, renamed or removed (refreshMarkers only takes the optional argument above). util.planReconcile takes two optional arguments after the tolerance, keepStray (4th) and follow (5th),
 *   and its result has two more lists: plan.strays (cuts left alone) and plan.swaps (the cuts a user's Accept replaces). Round 4 added three
 *   optional parts to follow (duplicates, own, ownTied; see planReconcile) and changed no member; the rest of this round is internal. Round 5
 *   added one more optional part, follow.ownSame, and changed no member either.
 *
 * Versions. 1.2.0 is the first change since the shipped 1.1.2. It adds one optional argument, refreshMarkers({ loaded: true }) (above),
 * and it follows the page's undo, redo and loaded sessions much more carefully (everything under "Cuts that appear or vanish" above);
 * no public member was removed or renamed. Words only, in the same version: the product is called Video Redline, and the panel's own
 * steps for a helper that is not running name the Video Redline icon on the Desktop first (it starts the helper and opens the page),
 * then setup-autostart-windows.bat for a computer without the icon, then start-helper-windows.bat for a person who would rather not
 * have the automatic start (that step begins "On Windows", so a Mac person does not read it as meant for them). The Mac steps are the same
 * as before. The panel never says that a page or a button starts the helper.
 */
var CleanupPanel = (function () {
  'use strict';

  var VERSION = '1.2.0';
  var KEYS = {
    transcript: 'vrt:cleanup:transcript',
    settings: 'vrt:cleanup:settings',
    decisions: 'vrt:cleanup:decisions',
    links: 'vrt:cleanup:links',
    ui: 'vrt:cleanup:ui'
  };
  var SVGNS = 'http://www.w3.org/2000/svg';
  var DECISION_TOL = 0.05;     // decisions match by kind and start time within 50 ms ...
  var OVERLAP_MIN = 0.5;       // ... or by kind and a range overlap of at least half of the shorter range
  var LEGACY_TOL = 0.15;       // a decision saved without an end time (panel 1.0.0) finds a candidate whose start is this close
  var NUM_LIMITS = { minGap: [0.2, 30], keepPause: [0, 3], autoPct: [50, 100] };
  var SCROLL_KEYS = { PageUp: 1, PageDown: 1, Home: 1, End: 1, ArrowUp: 1, ArrowDown: 1 };
  var PREVIEW_PAD = 1.2;       // preview plays this long before and after a cut
  var CHUNK_TOKENS = 48;       // transcript words per lazily rendered block
  var ROW_PAGE = 150;          // rows shown per list before "Show more"
  var MAX_FILE = 80 * 1024 * 1024;
  var MAX_DECISIONS = 6000;
  var MAX_UNDO = 100;
  var DEFAULT_LEVEL = 'balanced';
  var TIP_MIN = 60;            // more undecided cards than this: show the tip about the filters
  var ENGINES_ONE_LINE = 44;   // a header "Engines" line longer than this (characters) gets the "details" button
  var WORDS_CAP = 1200;        // wordsBetween() never returns more characters than this
  var TC_PORTS = [47831, 47832, 47833, 47834, 47835];
  var instanceCount = 0;       // gives the radio group of each panel its own name

  /* the filter chips of the queue: which engine kinds each one shows, and how to name them in a sentence */
  var CHIP_DEFS = [
    { id: 'all', label: 'All', one: 'cut', many: 'cuts' },
    { id: 'pause', label: 'Pauses', kinds: ['dead-space'], one: 'pause', many: 'pauses' },
    { id: 'um', label: 'Ums and ers', kinds: ['filler'], one: 'um or er', many: 'ums and ers' },
    { id: 'repeat', label: 'Repeats and stutters', kinds: ['repeat', 'stutter'], one: 'repeat or stutter', many: 'repeats and stutters' },
    { id: 'false-start', label: 'False starts', kinds: ['false-start'], one: 'false start', many: 'false starts' },
    { id: 'sound', label: 'Sounds', kinds: ['non-word'], one: 'sound', many: 'sounds' },
    { id: 'other', label: 'Other', kinds: [], one: 'other cut', many: 'other cuts' }
  ];
  /* plain-language steps when TranscriberClient.helpText is not there. A .command file from a GitHub ZIP is not marked as a
     program, so a double-click does nothing on a Mac: the Mac steps run it through Terminal instead. Windows and Mac are two ways to
     do ONE step, so they share it (numbered steps of their own would read as two things to do). A web page cannot start a program,
     so no step says that this page (or its Check again button) starts the helper: on Windows the Video Redline icon on the Desktop
     does (it starts the helper if needed and opens the page); setup-autostart-windows.bat adds that icon and makes the helper start by
     itself at every sign-in; start-helper-windows.bat (a window the person leaves open) is for someone who would rather not have that.
     Every step is one sentence of something to do. */
  var HELP_STEPS = {
    'no-helper': [
      'Start the helper. On Windows, double-click the Video Redline icon on your Desktop: it starts the helper and opens Video Redline in a new page that you can close. On a Mac: open Terminal, type bash and a space, drag start-helper-mac.command into the window, then press Return.',
      'On Windows, if there is no such icon yet, open the tools folder that came with this tool and double-click setup-autostart-windows.bat once: it adds the icon and makes the helper start by itself at every sign-in.',
      'On Windows, if you would rather not use the automatic start, double-click start-helper-windows.bat in the tools folder each time and leave its window open.',
      'Leave the helper running: if it has a window, do not close it.',
      'Come back here and press Check again.'
    ],
    'not-ready': [
      'Open the tools folder that came with this tool.',
      'Install the speech tools. On Windows, double-click setup-windows.bat. On a Mac: open Terminal, type bash and a space, drag setup-mac.command into the window, then press Return.',
      'Wait until it says ALL DONE.',
      'Start the helper again. On Windows, double-click the Video Redline icon on your Desktop (if there is none yet, double-click setup-autostart-windows.bat in the tools folder once: it adds the icon and starts the helper). On a Mac: open Terminal, type bash and a space, drag start-helper-mac.command into the window, then press Return.',
      'Come back here and press Check again.'
    ],
    busy: [
      'Wait until the helper has finished the transcript it is making (one that a Video Redline page you have closed started ends by itself after about 10 minutes).',
      'Then press Check again.'
    ]
  };
  var HELP_LEAD = {
    'no-helper': 'I cannot find the helper program on this computer yet.',
    'not-ready': 'The helper is running, but the speech tools are not installed yet.',
    busy: 'The helper is busy making another transcript.'
  };
  /* a helper that has only just started and is still checking its speech tools (client result: checking:true) is not broken: wait */
  var CHECKING_LEAD = 'The helper has just started and is still checking the speech tools.';
  var CHECKING_STEPS = ['Wait a few seconds.', 'Then press Check again.'];
  var CHECKING_RE = /still (?:starting up|checking)|just started/i;
  var NEXT_STEP = {
    'no-helper': 'Start the helper, then press Check again.',
    'not-ready': 'Install the speech tools, then press Check again.',
    busy: 'Wait for the other transcript to finish, then press Check again.',
    'disk-full': 'Free up some space on this computer, then try again.',
    'too-big': 'Export a smaller copy of the video and try again.',
    network: 'Make sure the helper is still running (on Windows, double-click the Video Redline icon on your Desktop to start it again; if you started it by hand and closed its window, double-click start-helper-windows.bat again; on a Mac, start it again through Terminal, the same way as before), then try again.',
    failed: 'Try once more. If it keeps failing, try a shorter recording.'
  };

  var KIND_CLASS = {
    'dead-space': 'cp-k-dead', filler: 'cp-k-filler', stutter: 'cp-k-stutter', repeat: 'cp-k-stutter',
    'false-start': 'cp-k-fstart', 'non-word': 'cp-k-nonword', manual: 'cp-k-manual'
  };
  var KIND_GROUP = {
    'dead-space': 'deadSpace', filler: 'ums', stutter: 'stutters', repeat: 'stutters', 'false-start': 'stutters', 'non-word': 'nonWords'
  };
  var KIND_FALLBACK = {
    'dead-space': { label: 'Dead space', help: 'A long silence between words.' },
    filler: { label: 'Um / er', help: 'A filler sound such as um, uh or er.' },
    stutter: { label: 'Stutter', help: 'A word started more than once, such as "wh- what".' },
    repeat: { label: 'Repeat', help: 'The same word said twice or more in a row.' },
    'false-start': { label: 'False start', help: 'A phrase that was dropped and restarted.' },
    'non-word': { label: 'Other sound', help: 'A breath, click or mouth noise that is not a word.' },
    manual: { label: 'Manual cut', help: 'You marked this to be cut.' }
  };
  var KEYMAP = [
    { keys: 'J', does: 'Next card' },
    { keys: 'K', does: 'Previous card' },
    { keys: 'A', does: 'Accept the highlighted card' },
    { keys: 'R', does: 'Reject the highlighted card' },
    { keys: 'Space', does: 'Preview the highlighted card (or the selected words when the transcript has focus)' },
    { keys: 'Z', does: 'Undo the last decision' },
    { keys: 'X', does: 'Cut the selected transcript words' },
    { keys: 'Esc', does: 'Clear the word selection' }
  ];

  /* ===========================================================================================
   * 1. pure helpers (no DOM): these are what the Node tests exercise
   * ========================================================================================= */

  function num(v, d) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

  /** 12.34 -> "0:12.34", 3723.5 -> "1:02:03.50" */
  function formatTime(t) {
    t = num(t, 0); if (t < 0) { t = 0; }
    var cs = Math.round(t * 100);
    var c = cs % 100;
    var s = Math.floor(cs / 100);
    var hh = Math.floor(s / 3600);
    var mm = Math.floor((s % 3600) / 60);
    s = s % 60;
    return hh > 0 ? hh + ':' + pad2(mm) + ':' + pad2(s) + '.' + pad2(c) : mm + ':' + pad2(s) + '.' + pad2(c);
  }

  /** whole seconds as m:ss (h:mm:ss from an hour): 204 -> "3:24" */
  function formatDuration(sec) {
    sec = Math.round(Math.max(0, num(sec, 0)));
    var hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), s = sec % 60;
    return hh > 0 ? hh + ':' + pad2(mm) + ':' + pad2(s) : mm + ':' + pad2(s);
  }

  /** a short length for people: 0.28 -> "0.28 s", 2.4 -> "2.4 s", 75 -> "1:15" */
  function formatLen(sec) {
    sec = Math.max(0, num(sec, 0));
    if (sec >= 60) { return formatDuration(sec); }
    if (sec < 1) { return (Math.round(sec * 100) / 100).toFixed(2) + ' s'; }
    return (Math.round(sec * 10) / 10).toFixed(1) + ' s';
  }

  /** "1:23.45", "83.5", "1:02:03", "1m23s", "83,5" -> seconds. NaN when it is not a time. */
  function parseTime(input) {
    if (typeof input === 'number') { return isFinite(input) && input >= 0 ? input : NaN; }
    var s = String(input == null ? '' : input).replace(/^\s+|\s+$/g, '').toLowerCase().replace(',', '.');
    if (!s) { return NaN; }
    var m = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s?)?$/.exec(s);
    if (m && (m[1] || m[2] || m[3])) {
      var tot = (m[1] ? parseInt(m[1], 10) * 3600 : 0) + (m[2] ? parseInt(m[2], 10) * 60 : 0) + (m[3] ? parseFloat(m[3]) : 0);
      return isFinite(tot) ? tot : NaN;
    }
    if (/^(\d+(\.\d*)?|\.\d+)$/.test(s)) { return parseFloat(s); }
    var parts = s.split(':');
    if (parts.length < 2 || parts.length > 3) { return NaN; }
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var last = i === parts.length - 1;
      if (!(last ? /^(\d+(\.\d*)?|\.\d+)$/ : /^\d+$/).test(p)) { return NaN; }
    }
    var secs = parseFloat(parts[parts.length - 1]);
    var mins = parseInt(parts[parts.length - 2], 10);
    var hrs = parts.length === 3 ? parseInt(parts[0], 10) : 0;
    if (secs >= 60) { return NaN; }
    if (parts.length === 3 && mins >= 60) { return NaN; }
    return hrs * 3600 + mins * 60 + secs;
  }

  var PUNCT_RE = /[\s.,;:!?"()\[\]{}<>\u201c\u201d\u2013\u2014\u2026\/\\|*_~`^=+@#$%&-]+/g;
  /** lowercase, curly quotes straightened, punctuation stripped: "Um," -> "um" */
  function normWord(w) {
    return String(w == null ? '' : w).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(PUNCT_RE, '').replace(/^'+|'+$/g, '');
  }

  function hashString(s) {
    var h1 = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0; }
    return h1.toString(16) + ':' + s.length;
  }

  /**
   * The identity of a transcript: video name and length, number of words, time of the first and the last word. The same
   * file gives the same id on every open, so decisions saved with it can be found again after a reload.
   */
  function makeTid(t) {
    var words = (t && Array.isArray(t.words)) ? t.words : [], n = words.length, v = (t && t.video && typeof t.video === 'object') ? t.video : {};
    var first = n ? words[0] : null, last = n ? words[n - 1] : null;
    function ms(x) { return Math.round(num(x, 0) * 1000); }
    return 't2:' + hashString([String(v.name == null ? '' : v.name), ms(v.duration), n, first ? ms(first.s) : 0, last ? ms(last.e) : 0].join('|'));
  }

  /** "You  know," -> "you know": every word of a phrase is cleaned, the single spaces between them stay */
  function normPhrase(w) {
    return String(w == null ? '' : w).toLowerCase().split(/\s+/).map(normWord).filter(Boolean).join(' ');
  }
  function parseFillerList(text) {
    var out = [], seen = {};
    String(text == null ? '' : text).split(/[,;\n]+/).forEach(function (w) {
      var n = normPhrase(w);
      if (n && !seen[n]) { seen[n] = true; out.push(n); }
    });
    return out;
  }

  function baseName(p) { return String(p == null ? '' : p).replace(/\\/g, '/').split('/').pop().replace(/^\s+|\s+$/g, '').toLowerCase(); }
  /**
   * Does a saved reference ({name, duration}) describe another video than the open one (cur)? Returns '' (same or cannot
   * tell), 'length' or 'name'. A length counts as different when it is off by more than max(2 s, 2 %).
   */
  function videoDiffers(ref, cur) {
    ref = ref || {}; cur = cur || {};
    if (ref.duration > 0 && cur.duration > 0 && Math.abs(ref.duration - cur.duration) > Math.max(2, cur.duration * 0.02)) { return 'length'; }
    if (ref.name && cur.name && baseName(ref.name) !== baseName(cur.name)) { return 'name'; }
    return '';
  }

  function mergeRanges(ranges, gap) {
    gap = gap == null ? 0 : gap;
    var a = [];
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      if (r && isFinite(r.start) && isFinite(r.end) && r.end > r.start) { a.push({ start: r.start, end: r.end }); }
    }
    a.sort(function (x, y) { return x.start - y.start || x.end - y.end; });
    var out = [];
    for (var j = 0; j < a.length; j++) {
      var last = out[out.length - 1];
      if (last && a[j].start <= last.end + gap) { if (a[j].end > last.end) { last.end = a[j].end; } }
      else { out.push({ start: a[j].start, end: a[j].end }); }
    }
    return out;
  }
  function rangesLength(ranges) {
    var m = mergeRanges(ranges, 0), t = 0;
    for (var i = 0; i < m.length; i++) { t += m[i].end - m[i].start; }
    return t;
  }

  /**
   * The one-line summary. It says plainly how much was done on its own and how much waits:
   *   "Found 295 cuts: 113 applied on their own (2:11), 182 need you (8:32)."
   * The seconds in brackets are left out when n.appliedSeconds / n.pendingSeconds are not numbers. n.brief gives the shorter
   * line that ends the "Create transcript" card: "Found 295 cuts: 113 applied on their own, 182 need you. Saves 2:11."
   */
  function summaryText(n) {
    var saves = ' Saves ' + formatDuration(n.saves || 0) + '.';
    if (!n.total) { return 'No cuts found: no dead space, ums or stutters to remove.' + (n.saves > 0 ? saves : ''); }
    var showSecs = !n.brief;
    function secs(v) { return showSecs && typeof v === 'number' && isFinite(v) ? ' (' + formatDuration(v) + ')' : ''; }
    var done = n.applied + ' ' + plural(n.applied, 'applied on its own', 'applied on their own') + secs(n.appliedSeconds);
    var pend = n.pending === 0 ? 'none need you' : (n.pending + ' ' + plural(n.pending, 'needs', 'need') + ' you' + secs(n.pendingSeconds));
    return 'Found ' + n.total + ' ' + plural(n.total, 'cut', 'cuts') + ': ' + done + ', ' + pend + '.' + (n.brief ? saves : '');
  }
  /** the note under the level choice: "Balanced: 113 applied on their own, 182 need you." */
  function levelNoteText(label, applied, pending) {
    return label + ': ' + applied + ' ' + plural(applied, 'applied on its own', 'applied on their own') + ', ' +
      (pending === 0 ? 'none need you' : pending + ' ' + plural(pending, 'needs', 'need') + ' you') + '.';
  }

  /** which chip a candidate kind belongs to ('other' for a kind this version does not know) */
  function chipIdOf(kind) {
    for (var i = 0; i < CHIP_DEFS.length; i++) { if (CHIP_DEFS[i].kinds && CHIP_DEFS[i].kinds.indexOf(kind) >= 0) { return CHIP_DEFS[i].id; } }
    return 'other';
  }
  function chipDef(id) {
    for (var i = 0; i < CHIP_DEFS.length; i++) { if (CHIP_DEFS[i].id === id) { return CHIP_DEFS[i]; } }
    return CHIP_DEFS[0];
  }
  /** cards per chip: { all: n, pause: n, ... } for a list of candidates */
  function chipCounts(list) {
    var o = { all: list.length };
    CHIP_DEFS.forEach(function (d) { if (d.id !== 'all') { o[d.id] = 0; } });
    list.forEach(function (c) { o[chipIdOf(c.kind)]++; });
    return o;
  }
  /** a number of seconds for a sentence: "4.2 s" under a minute, else "3:12" */
  function sentenceLen(sec) { return formatLen(sec); }
  /** the question before a bulk action: "Accept all 54 pauses? That removes 3:12 from the video." */
  function bulkQuestion(accept, chipId, n, seconds) {
    var d = chipDef(chipId), noun = n === 1 ? d.one : d.many, len = sentenceLen(seconds);
    return (accept ? 'Accept ' : 'Reject ') + (n > 1 ? 'all ' : '') + n + ' ' + noun + '? ' +
      (accept ? 'That removes ' + len + ' from the video.' : 'That keeps ' + len + ' in the video.');
  }

  /* ---- the words of a transcript in a time range (for export) ---- */
  /** a sorted index of the words: starts, ends and a running maximum of the ends, so that a range can be found by binary search */
  function buildWordIndex(words) {
    var n = words.length, order = [], i, sorted = true;
    function st(k) { return num(words[k] && words[k].s, 0); }
    for (i = 0; i < n; i++) { order.push(i); if (i && st(i) < st(i - 1)) { sorted = false; } }
    if (!sorted) { order.sort(function (a, b) { return st(a) - st(b) || a - b; }); }
    var starts = new Array(n), ends = new Array(n), pm = new Array(n), mx = -Infinity;
    for (i = 0; i < n; i++) {
      var w = words[order[i]];
      starts[i] = num(w && w.s, 0); ends[i] = num(w && w.e, starts[i]);
      if (ends[i] > mx) { mx = ends[i]; }
      pm[i] = mx;
    }
    return { n: n, order: order, starts: starts, ends: ends, pm: pm };
  }
  /**
   * is the word [s, e] "said in" the range [t0, t1]? Only when at least half of the word is inside the range: the word that ends a
   * sentence just before a marker, or begins the next one just after it, overlaps by a frame or two and is not part of it. A word
   * that only touches an edge is not inside. A range shorter than the word it sits on (a one-second marker on a long word, a single
   * frame) counts when at least half of the range is inside the word, so it is never empty because of that. A point (t0 == t1) is
   * inside the word it falls in, and a word of no length is inside the range it falls in (the edges themselves are not).
   */
  function wordInRange(s, e, t0, t1) {
    if (!(e > s) || !(t1 > t0)) { return e > t0 && s < t1; }
    var inside = Math.min(e, t1) - Math.max(s, t0);
    return inside > 0 && inside * 2 >= Math.min(e - s, t1 - t0) - 1e-9;
  }
  /** the words said in [t0, t1] (see wordInRange), joined with single spaces and tidied; at most WORDS_CAP characters, ending in an ellipsis when cut */
  function wordsInRangeText(words, idx, t0, t1, cap) {
    t0 = typeof t0 === 'number' ? t0 : parseFloat(t0); t1 = typeof t1 === 'number' ? t1 : parseFloat(t1);
    cap = cap || WORDS_CAP;
    if (!idx || !idx.n || !isFinite(t0) || !isFinite(t1)) { return ''; }
    if (t1 < t0) { var sw = t0; t0 = t1; t1 = sw; }
    var lo = 0, hi = idx.n, mid;
    while (lo < hi) { mid = (lo + hi) >> 1; if (idx.pm[mid] > t0) { hi = mid; } else { lo = mid + 1; } }
    var first = lo;
    lo = first; hi = idx.n;
    while (lo < hi) { mid = (lo + hi) >> 1; if (idx.starts[mid] < t1) { lo = mid + 1; } else { hi = mid; } }
    var stop = lo, parts = [], len = 0;
    for (var p = first; p < stop && len <= cap + 1; p++) {
      if (!wordInRange(idx.starts[p], idx.ends[p], t0, t1)) { continue; }
      var w = words[idx.order[p]], txt = String(w && w.w != null ? w.w : '').replace(/\s+/g, ' ').replace(/^ | $/g, '');
      if (!txt) { continue; }
      parts.push(txt); len += txt.length + 1;
    }
    var text = parts.join(' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
    if (text.length <= cap) { return text; }
    var cut = text.slice(0, cap - 1), sp = cut.lastIndexOf(' ');
    if (sp > cap - 60) { cut = cut.slice(0, sp); }
    return cut.replace(/\s+$/, '') + '\u2026';
  }

  /* ---- the "Create transcript" card ---- */
  /** the plain-language line for what the helper is doing */
  function stageLine(phase, message) {
    var m = String(message || '');
    if (phase === 'checking') { return CHECKING_RE.test(m) ? 'The helper has just started. Waiting for it to finish checking...' : 'Looking for the helper on your computer...'; }
    if (phase === 'uploading') { return 'Sending the video to the helper on your computer...'; }
    if (phase === 'finishing') { return 'Looking for ums and pauses...'; }
    // the client's own line while the helper does not answer (transcriber-client.js LOST_CONTACT_MESSAGE): say it on the main line
    if (/^\s*lost contact\b/i.test(m)) { return 'Lost contact with the helper. Trying again...'; }
    if (/\b(ums?|uhs?|ers?|quiet|silen\w*|pauses?|gaps?|loudness)\b/i.test(m)) { return 'Looking for ums and pauses...'; }
    // the helper's other stages (vrt_server.py STAGE_TEXT): say what it is really doing; the word step is the fallback
    if (/^\s*(getting ready|the helper is starting)\b/i.test(m)) { return 'Getting ready...'; }
    if (/^\s*reading the sound\b/i.test(m)) { return 'Reading the sound from your video...'; }
    if (/^\s*putting it all together\b/i.test(m)) { return 'Putting the cuts together...'; }
    return 'Listening for words...';
  }
  /** "About 2 minutes left"; '' when the time is not known */
  function formatEta(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) { return ''; }
    if (sec < 10) { return 'Almost done'; }
    if (sec < 90) { return 'About ' + (Math.round(sec / 5) * 5) + ' seconds left'; }
    var m = Math.round(sec / 60);
    if (m < 90) { return 'About ' + m + ' minutes left'; }
    var hh = Math.floor(m / 60), mm = m % 60;
    return 'About ' + hh + ' h ' + (mm ? mm + ' min ' : '') + 'left';
  }
  /**
   * cut a paragraph into sentences (each one becomes a numbered step). A sentence that begins "On a Mac" stays with the one before it:
   * it is the other way to do that same step (Windows or Mac), not a second thing to do.
   */
  function splitSteps(text) {
    var words = String(text == null ? '' : text).replace(/\s+/g, ' ').replace(/^ | $/g, '').split(' '), out = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      if (!words[i]) { continue; }
      cur += (cur ? ' ' : '') + words[i];
      var next = words[i + 1], onMac = next === 'On' && words[i + 2] === 'a' && /^Mac\b/.test(words[i + 3] || '');
      if (/[.!?]["')]*$/.test(words[i]) && (!next || /^[A-Z("]/.test(next)) && !onMac) { out.push(cur); cur = ''; }
    }
    if (cur) { out.push(cur); }
    return out.slice(0, 8);
  }
  /**
   * While the help card shows, its only button is "Check again". A step that tells the user to click "Create transcript"
   * (again) would point at a button that is not there, so it is reworded: "click Create transcript again" -> "press Check again".
   */
  function pressCheckAgain(step) {
    return String(step == null ? '' : step).replace(/\b(click|press)\s+(?:the\s+)?(?:button\s+)?["\u201c]?Create transcript(?:\s+and\s+find\s+cuts)?["\u201d]?(?:\s+again)?/gi, function (m, verb) {
      return (verb.charAt(0) === verb.charAt(0).toUpperCase() ? 'Press' : 'press') + ' Check again';
    });
  }
  function wordsOfText(s) {
    var all = String(s == null ? '' : s).toLowerCase().match(/[a-z0-9']+/g) || [], out = [];
    all.forEach(function (w) { if (out.indexOf(w) < 0) { out.push(w); } });
    return out;
  }
  /** does this step only say again what the sentence above it says? (at least 4 words, and 80 % of them are in that sentence) */
  function repeatsLead(step, lead) {
    var sw = wordsOfText(step), lw = wordsOfText(lead), hit = 0;
    sw.forEach(function (w) { if (lw.indexOf(w) >= 0) { hit++; } });
    return sw.length >= 4 && hit / sw.length >= 0.8;
  }
  function alnumKey(s, n) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, n || 80); }
  /**
   * The parts of the help card: one lead sentence (what the helper says is wrong) and numbered steps (what to do).
   *   problem   the helper's own explanation (may be empty);  help   the plain-language advice (the client's err.help, else
   *   TranscriberClient.helpText(code); may be empty);  checking   the helper has only just started.
   * A helper that is still checking its tools gets exactly "Wait a few seconds." / "Then press Check again."; the advice never
   * says to click a button that is not on the card; a step or a lead that only repeats the other is dropped.
   */
  function helpCard(code, problem, help, checking) {
    var lead = typeof problem === 'string' && problem.replace(/\s+/g, '') ? clip(problem.replace(/\s+/g, ' ').replace(/^ | $/g, ''), 400) : '';
    var steps;
    if (code === 'not-ready' && checking) { return { lead: lead || CHECKING_LEAD, steps: CHECKING_STEPS.slice() }; }
    steps = splitSteps(help).map(pressCheckAgain);
    if (!steps.length) { steps = (HELP_STEPS[code] || HELP_STEPS['no-helper']).slice(); }
    // the helper gave no reason of its own and the client's advice is the same paragraph: say it once
    if (lead && alnumKey(lead) === alnumKey(help)) { lead = ''; }
    if (!lead) { lead = HELP_LEAD[code] || HELP_LEAD['no-helper']; }
    while (steps.length > 1 && repeatsLead(steps[0], lead)) { steps.shift(); }
    return { lead: lead, steps: steps };
  }

  /**
   * ---- decisions: [{ kind, start, end, d:'accept'|'reject' }] ----
   * A decision belongs to a candidate of the same kind whose start is within 50 ms, or (when both ranges are known) whose
   * range overlaps it by at least half of the shorter one. The second rule is what keeps a decision on a dead-space cut when
   * "Leave a pause of" moves both of its edges. A decision written by an older version has no end: start only, and only 50 ms
   * apart, except when it is matched to a candidate (findDecisionIdx with a range): then a start within 0.15 s is enough, because
   * the next engine moves false starts, repeats and stutters by 70-90 ms. Nearest first, and after every decision that has an end.
   * rangeMatch returns -1 for no match, else a score (lower is better; same start first, then the best overlap).
   */
  function rangeMatch(aStart, aEnd, bStart, bEnd) {
    var ds = Math.abs(aStart - bStart);
    if (ds <= DECISION_TOL) { return ds; }
    if (isFinite(aEnd) && isFinite(bEnd) && aEnd > aStart && bEnd > bStart) {
      var ov = Math.min(aEnd, bEnd) - Math.max(aStart, bStart), shorter = Math.min(aEnd - aStart, bEnd - bStart);
      if (ov > 0 && ov >= OVERLAP_MIN * shorter) { return 1 + (1 - ov / shorter); }
    }
    return -1;
  }
  function findDecisionIdx(list, kind, start, end) {
    var best = -1, bs = 1e9, ranged = isFinite(end) && end > start;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (d.kind !== kind) { continue; }
      var sc = rangeMatch(d.start, d.end, start, end);
      if (sc < 0 && ranged && !(d.end > d.start)) {      // saved without an end time: the start only has to be near
        var dl = Math.abs(d.start - start);
        if (dl <= LEGACY_TOL + 1e-9) { sc = 3 + dl; }
      }
      if (sc >= 0 && sc < bs) { best = i; bs = sc; }
    }
    return best;
  }
  function getDecision(list, kind, start, end) { var i = findDecisionIdx(list, kind, start, end); return i < 0 ? null : list[i]; }
  function setDecision(list, kind, start, d, end) {
    var i = findDecisionIdx(list, kind, start, end), hasEnd = isFinite(end) && end > start;
    if (i >= 0) { list[i].d = d; list[i].start = start; if (hasEnd) { list[i].end = end; } }
    else {
      var rec = { kind: kind, start: start, d: d };
      if (hasEnd) { rec.end = end; }
      list.push(rec);
      if (list.length > MAX_DECISIONS) { list.shift(); }
    }
  }
  function removeDecision(list, kind, start, end) { var i = findDecisionIdx(list, kind, start, end); if (i >= 0) { list.splice(i, 1); } }
  function copyDecisions(list) {
    return list.map(function (d) { var o = { kind: d.kind, start: d.start, d: d.d }; if (isFinite(d.end)) { o.end = d.end; } return o; });
  }
  function cleanDecisions(raw) {
    var out = [];
    if (!Array.isArray(raw)) { return out; }
    raw.forEach(function (d) {
      if (d && typeof d.kind === 'string' && isFinite(d.start) && (d.d === 'accept' || d.d === 'reject')) {
        var o = { kind: d.kind, start: +d.start, d: d.d };
        if (typeof d.end === 'number' && isFinite(d.end) && d.end > o.start) { o.end = d.end; }
        out.push(o);
      }
    });
    return out.slice(-MAX_DECISIONS);
  }
  /** what changed between two decision lists: [{ before: decision|null, after: decision|null }] (used by Undo) */
  function diffDecisions(before, after) {
    function key(d) { return d.kind + '|' + d.start + '|' + (isFinite(d.end) ? d.end : ''); }
    var bm = {}, am = {}, out = [];
    before.forEach(function (d) { bm[key(d)] = d; });
    after.forEach(function (d) { am[key(d)] = d; });
    after.forEach(function (d) {
      var b = bm[key(d)];
      if (!b || b.d !== d.d) { out.push({ before: b ? copyDecisions([b])[0] : null, after: copyDecisions([d])[0] }); }
    });
    before.forEach(function (d) { if (!am[key(d)]) { out.push({ before: copyDecisions([d])[0], after: null }); } });
    return out;
  }
  /**
   * Take back recorded changes (newest first) on the live list, but only the ones nobody has touched since: a decision that
   * is no longer what the change left behind (the user deleted that cut in the page, for example) is left alone.
   * Returns how many changes were taken back.
   */
  function revertDecisions(list, changes) {
    var done = 0, i, ch;
    for (i = changes.length - 1; i >= 0; i--) {          // first the decisions the change made or altered ...
      ch = changes[i];
      if (!ch.after) { continue; }
      var idx = findDecisionIdx(list, ch.after.kind, ch.after.start, ch.after.end);
      if (idx < 0 || list[idx].d !== ch.after.d) { continue; }
      list.splice(idx, 1);
      if (ch.before) { list.push(copyDecisions([ch.before])[0]); }
      done++;
    }
    for (i = changes.length - 1; i >= 0; i--) {          // ... then the ones it removed
      ch = changes[i];
      if (ch.after || !ch.before) { continue; }
      if (findDecisionIdx(list, ch.before.kind, ch.before.start, ch.before.end) >= 0) { continue; }
      list.push(copyDecisions([ch.before])[0]);
      done++;
    }
    return done;
  }

  /**
   * Turn the engine's candidates into panel candidates: apply the kind switches, the safety rule (an "auto" candidate
   * below the user's confidence threshold is shown for review) and the user's earlier decisions.
   * st: 'auto' (applied automatically) | 'pending' (needs a decision) | 'accepted' | 'rejected'
   */
  function classifyCandidates(cands, decisions, threshold, include) {
    var out = [];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c || !isFinite(c.start) || !isFinite(c.end)) { continue; }
      var grp = KIND_GROUP[c.kind];
      if (include && grp && include[grp] === false) { continue; }
      var o = {};
      for (var k in c) { if (Object.prototype.hasOwnProperty.call(c, k)) { o[k] = c[k]; } }
      o.confidence = clamp(num(c.confidence, 0.5), 0, 1);
      o.eff = (c.status === 'auto' && o.confidence + 1e-9 >= threshold) ? 'auto' : 'review';
      o.failed = false;
      o.st = stateFromDecision(o, decisions);
      out.push(o);
    }
    return out;
  }
  function stateFromDecision(c, decisions) {
    var d = getDecision(decisions, c.kind, c.start, c.end);
    if (d) { return d.d === 'accept' ? 'accepted' : 'rejected'; }
    if (c.failed) { return 'pending'; }
    return c.eff === 'auto' ? 'auto' : 'pending';
  }

  /**
   * Which cut belongs to which card: the ONE matching rule. planReconcile uses it to decide what to add or remove, and the panel's
   * "take on what came back" step (adoptRestored) uses it to decide which card a returned cut speaks for, so the two can never
   * disagree: a cut that adoptRestored takes on for a card is a cut planReconcile pairs with that card (and so leaves alone), and a
   * cut that fits no card by this rule is taken on for none. Every cut goes to at most one card and every card gets at most one cut:
   *   pass 1  the cut carries the card's id (origin.candidateId)
   *   pass 2  same kind, start within tol
   *   pass 3  same kind, the ranges overlap by at least half of the shorter one (the card moved)
   *   pass 4  the panel tied the cut to this card earlier (link.card) and it fits nothing now, e.g. the user trimmed it
   * links: [{id,kind,start,end,cid,card}]. Returns { assigned[i]: the cut of cands[i] (or undefined), moved[i]: it fits by overlap or by
   * its tie only, tied[i]: by its tie only, extras: [{ link, card: i }] more cuts that fit card i (they are the card's too), used: {cut id: true} }.
   */
  function assignCuts(cands, links, tol) {
    var used = {}, byCid = {}, byKind = {}, byCard = {};
    links.forEach(function (l) {
      if (l.cid) { (byCid[l.cid] = byCid[l.cid] || []).push(l); }
      if (l.card) { (byCard[l.card] = byCard[l.card] || []).push(l); }
      (byKind[l.kind] = byKind[l.kind] || []).push(l);
    });
    Object.keys(byKind).forEach(function (k) { byKind[k].sort(function (a, b) { return a.start - b.start; }); });
    var assigned = new Array(cands.length), moved = new Array(cands.length), tiedPass = new Array(cands.length), extras = [];
    var i, j, c, l;
    function more(x, card) { used[x.id] = true; extras.push({ link: x, card: card }); }
    for (i = 0; i < cands.length; i++) {            // pass 1: exact candidate id
      c = cands[i];
      var same = (byCid[c.id] || []).filter(function (x) { return !used[x.id] && x.kind === c.kind; });
      if (same.length) {
        assigned[i] = same[0]; used[same[0].id] = true;
        for (j = 1; j < same.length; j++) { more(same[j], i); }
      }
    }
    for (i = 0; i < cands.length; i++) {            // pass 2: same kind, start within tolerance
      if (assigned[i]) { continue; }
      c = cands[i];
      var arr = byKind[c.kind] || [];
      var near = [];
      for (j = 0; j < arr.length; j++) {
        l = arr[j];
        if (used[l.id]) { continue; }
        if (l.start > c.start + tol) { break; }
        if (Math.abs(l.start - c.start) <= tol) { near.push(l); }
      }
      if (near.length) {
        near.sort(function (a, b) { return Math.abs(a.start - c.start) - Math.abs(b.start - c.start); });
        assigned[i] = near[0]; used[near[0].id] = true;
        for (j = 1; j < near.length; j++) { more(near[j], i); }
      }
    }
    for (i = 0; i < cands.length; i++) {            // pass 3: same kind, ranges overlap (the candidate moved)
      if (assigned[i]) { continue; }
      c = cands[i];
      if (!(c.end > c.start)) { continue; }
      var arr3 = byKind[c.kind] || [], over = [];
      for (j = 0; j < arr3.length; j++) {
        l = arr3[j];
        if (used[l.id]) { continue; }
        if (l.start >= c.end) { break; }
        var sc = rangeMatch(l.start, l.end, c.start, c.end);
        if (sc >= 0) { over.push({ l: l, sc: sc }); }
      }
      if (over.length) {
        over.sort(function (a, b) { return a.sc - b.sc; });
        assigned[i] = over[0].l; moved[i] = true; used[over[0].l.id] = true;
        for (j = 1; j < over.length; j++) { more(over[j].l, i); }
      }
    }
    for (i = 0; i < cands.length; i++) {            // pass 4: a cut that was tied to this card earlier (link.card) and fits nothing now, e.g. the user trimmed it
      if (assigned[i]) { continue; }
      c = cands[i];
      var tied = (byCard[c.id] || []).filter(function (x) { return !used[x.id] && x.kind === c.kind; });
      if (tied.length) {
        assigned[i] = tied[0]; moved[i] = true; tiedPass[i] = true; used[tied[0].id] = true;
        for (j = 1; j < tied.length; j++) { more(tied[j], i); }
      }
    }
    return { assigned: assigned, moved: moved, tied: tiedPass, extras: extras, used: used };
  }

  /**
   * Work out which cuts to add / remove so the page's cuts match the candidates' states.
   * cands: classified candidates. links: the panel's own cuts [{id,kind,start,end,auto,cid}].
   * A candidate in state auto / accepted should have exactly one cut; every other candidate should have none.
   * Own cuts that match no candidate are removed when they were automatic, kept when the user accepted / drew them.
   * A cut is matched to a candidate by candidate id, else by kind and start within tol, else by kind and an overlap of at
   * least half of the shorter range (the candidate moved, e.g. "Leave a pause of" changed), else by link.card, the id of the candidate
   * the cut was tied to earlier (see reconcileNow). A cut matched only by overlap is
   * replaced by a cut with the candidate's new range (it goes to both remove and add), so no orphan or overlapping
   * duplicate is left behind.
   * keepStray (optional): function(link) -> true to leave an automatic cut that matches no candidate alone (it goes to
   * plan.strays instead of plan.remove). The panel uses it for cuts it never made itself, such as those of a loaded session
   * that came from another transcript.
   * follow (optional): how to treat cuts that came back through the page (undo, redo, a loaded session) and that the panel did
   * not make itself. Taking them out, or replacing them, is a new step in the page's history: it cuts off the redo steps and the
   * next undo returns to the same cuts, so the history would never move. Every part is optional:
   *   follow.pending(link)  true: an automatic cut on a card that needs a decision stays (plan.strays), also a further one on that card
   *   follow.unknown(link)  true: an automatic cut on a card the user rejected stays too (plan.strays)
   *   follow.moved          true: a cut that fits its card only by overlap stays as it is (plan.keep) instead of being replaced
   *   follow.tied           true: a cut that fits its card only by overlap and that the panel tied to the card earlier (link.card) stays as it is
   *   follow.own            true: the same for every cut the user accepted (link.auto false) that fits its card by overlap or by its tie, tied or not: the
   *                         card moved because the engine changed, not because the user did anything, and the cut is the user's, at the place they chose
   *   follow.ownTied        true: a cut the user accepted that the panel tied to its card earlier (link.card) stays as it is, when something else was decided
   *   follow.ownSame        true: the same, but only when the card it was tied to is still this very card (same id): a setting was changed and the card is
   *                         the one the cut was tied to, so the cut is still its cut (like a cut that carries the card's id). A card that moved to another id
   *                         (the pause was lengthened) gets its new range as before
   *   follow.ownAccept      true: the user has accepted this card, and the cut it holds is an automatic one (it came back through
   *                         the page). An automatic cut is not the user's, and the page records who made a cut: the cut is swapped
   *                         for one that records the Accept (plan.swaps), so page undo, redo and a loaded session keep the Accept.
   *                         A swap says whether the cut fitted its card by overlap alone (swap.overlap): its range then comes from
   *                         other settings, not from the card the user looked at
   *   follow.extra          true: an automatic cut that is left over once every card has its cut, and that overlaps a card (the other
   *                         half of a card that merged two cards), stays even when the panel made it (plan.strays)
   *   follow.rejected       true: such a left-over cut that overlaps a card the user rejected is taken out (plan.remove), not left:
   *                         the Reject decided about that card, and a cut left behind would be read as a returned one and undo it
   *   follow.duplicates     true: a further cut that fits a card which has its own cut already (assignCuts extras: a long card that two of
   *                         the page's cuts lie in, say after the page went back to the cuts of another transcript) stays too, in
   *                         plan.strays (plan.orphans when the user accepted it) instead of plan.remove: taking it out is a new step in the
   *                         page's history, and the page's undo would never get past it
   */
  function planReconcile(cands, links, tol, keepStray, follow) {
    follow = follow || {};
    tol = tol == null ? DECISION_TOL : tol;
    var plan = { add: [], remove: [], keep: [], orphans: [], strays: [], swaps: [] };
    var found = assignCuts(cands, links, tol);
    var used = found.used, assigned = found.assigned, moved = found.moved, tiedPass = found.tied;
    var i, c, l;
    for (i = 0; i < cands.length; i++) {
      c = cands[i]; l = assigned[i];
      var want = c.st === 'auto' || c.st === 'accepted';
      if (want) {
        if (l && c.st === 'accepted' && l.auto && follow.ownAccept) { plan.swaps.push({ cand: c, link: l, overlap: !!moved[i] && !tiedPass[i] }); }
        else if (l && moved[i] && !follow.moved && !(follow.tied && l.card) && !(follow.own && !l.auto) && !(follow.ownTied && !l.auto && l.card) && !(follow.ownSame && !l.auto && l.card === c.id)) { plan.remove.push(l); plan.add.push(c); }
        else if (l) { plan.keep.push({ cand: c, link: l, moved: !!moved[i] }); }
        else { plan.add.push(c); }
      } else if (l) {
        var leave = c.st === 'pending' ? follow.pending : follow.unknown;
        if (typeof leave === 'function' && leave(l)) { plan.strays.push(l); }
        else { plan.remove.push(l); }
      }
    }
    found.extras.forEach(function (e) {
      var x = e.link;
      if (follow.duplicates) { (x.auto ? plan.strays : plan.orphans).push(x); }
      else if (cands[e.card].st === 'pending' && typeof follow.pending === 'function' && follow.pending(x)) { plan.strays.push(x); }      // as the cut the card holds: it waits for a decision
      else { plan.remove.push(x); }
    });
    function cardOf(x) {                            // the card a left-over cut belongs to: its own id, else the best overlap (as pass 3)
      var best = null, bs = 1e9;
      for (var k = 0; k < cands.length; k++) {
        var q = cands[k];
        if (q.kind !== x.kind) { continue; }
        if (x.cid && q.id === x.cid) { return q; }
        var sq = rangeMatch(x.start, x.end, q.start, q.end);
        if (sq >= 0 && sq < bs) { best = q; bs = sq; }
      }
      return best;
    }
    links.forEach(function (x) {
      if (used[x.id]) { return; }
      if (!x.auto) { plan.orphans.push(x); return; }
      var mine = (follow.extra || follow.rejected) ? cardOf(x) : null;
      if (follow.rejected && mine && mine.st === 'rejected') { plan.remove.push(x); }
      else if (typeof keepStray === 'function' && keepStray(x)) { plan.strays.push(x); }
      else if (follow.extra && mine) { plan.strays.push(x); }
      else { plan.remove.push(x); }
    });
    return plan;
  }

  /* ---- tokens: transcript words plus a "gap" chip for each candidate that has no words (dead space, sounds) ---- */
  function placeholderText(c) {
    if (c.text && /^\[/.test(c.text)) { return clip(c.text, 28); }
    if (c.kind === 'dead-space') { return '[' + formatLen(c.end - c.start) + ' silence]'; }
    return '[' + (c.text ? clip(c.text, 24) : (c.kind === 'non-word' ? 'sound' : 'cut')) + ']';
  }
  function buildTokens(words, cands) {
    var n = words.length, order = [], i;
    var sorted = true;
    for (i = 0; i < n; i++) { order.push(i); if (i && words[i].s < words[i - 1].s) { sorted = false; } }
    if (!sorted) { order.sort(function (a, b) { return words[a].s - words[b].s || a - b; }); }
    var chips = [];
    for (i = 0; i < cands.length; i++) { if (!cands[i].words || !cands[i].words.length) { chips.push(i); } }
    chips.sort(function (a, b) { return cands[a].start - cands[b].start; });
    var tokens = [], wordTok = new Array(n), wtoks = [], chipTok = {}, ci = 0;
    function pushChip(k) {
      var c = cands[k];
      chipTok[k] = tokens.length;
      tokens.push({ k: 1, i: k, s: c.start, e: c.end, t: placeholderText(c), n: '' });
    }
    for (var oi = 0; oi < order.length; oi++) {
      var wi = order[oi], w = words[wi];
      while (ci < chips.length && cands[chips[ci]].start <= w.s) { pushChip(chips[ci]); ci++; }
      wordTok[wi] = tokens.length; wtoks.push(tokens.length);
      tokens.push({ k: 0, i: wi, s: w.s, e: w.e, t: String(w.w), n: normWord(w.w) });
    }
    while (ci < chips.length) { pushChip(chips[ci]); ci++; }
    return { tokens: tokens, wordTok: wordTok, wtoks: wtoks, chipTok: chipTok };
  }

  /** blocks of roughly max tokens, ending at sentence ends when possible. [{from,to}) half open */
  function chunkTokens(tokens, max) {
    max = max || CHUNK_TOKENS;
    var out = [], from = 0, n = tokens.length;
    for (var i = 0; i < n; i++) {
      var cnt = i - from + 1;
      var end = cnt >= max * 1.5 || (cnt >= max * 0.6 && /[.!?]["')\u201d]*$/.test(tokens[i].t));
      if (end || i === n - 1) { out.push({ from: from, to: i + 1 }); from = i + 1; }
    }
    return out;
  }

  /** index of the token being spoken at time t (or the last one within slack seconds after it), else -1 */
  function findTokenAt(tokens, t, slack) {
    var lo = 0, hi = tokens.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tokens[mid].s <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (idx < 0) { return -1; }
    for (var j = idx; j >= 0 && j >= idx - 3; j--) { if (t < tokens[j].e) { return j; } }
    return (t - tokens[idx].e) <= (slack || 0) ? idx : -1;
  }

  /** which tokens sit inside a cut (token midpoint inside any cut). Returns an array of 0/1 */
  function flagCutTokens(tokens, cuts) {
    var m = mergeRanges(cuts, 0), flags = new Array(tokens.length);
    for (var i = 0; i < tokens.length; i++) {
      var mid = (tokens[i].s + tokens[i].e) / 2, lo = 0, hi = m.length - 1, f = 0;
      while (lo <= hi) {
        var k = (lo + hi) >> 1;
        if (m[k].end < mid) { lo = k + 1; } else if (m[k].start > mid) { hi = k - 1; } else { f = 1; break; }
      }
      flags[i] = f;
    }
    return flags;
  }

  /** selected tokens a..b (any order) -> the time range to cut: first start minus pad, last end plus pad */
  function selectionToRange(tokens, a, b, pad, duration) {
    var lo = Math.max(0, Math.min(a, b)), hi = Math.min(tokens.length - 1, Math.max(a, b));
    if (!tokens.length || lo > hi) { return null; }
    var s = Infinity, e = -Infinity, words = [], nWords = 0;
    for (var i = lo; i <= hi; i++) {
      if (tokens[i].s < s) { s = tokens[i].s; }
      if (tokens[i].e > e) { e = tokens[i].e; }
      if (!tokens[i].k) { nWords++; }
      words.push(tokens[i].t);
    }
    pad = pad == null ? 0.02 : pad;
    s = Math.max(0, s - pad); e = e + pad;
    if (duration > 0 && e > duration) { e = duration; }
    if (!(e > s)) { return null; }
    return { start: s, end: e, count: hi - lo + 1, words: nWords, text: clip(words.join(' '), 90), lo: lo, hi: hi };
  }

  /** search the word tokens for the typed words. Short terms (1 to 2 letters) must match exactly, longer ones by prefix. */
  function searchTokens(tokens, wtoks, query) {
    var terms = String(query == null ? '' : query).split(/\s+/).map(normWord).filter(Boolean);
    var hits = [];
    if (!terms.length) { return hits; }
    function ok(tok, term) { return term.length <= 2 ? tok.n === term : tok.n.indexOf(term) === 0; }
    for (var i = 0; i + terms.length <= wtoks.length && hits.length < 5000; i++) {
      var good = true;
      for (var k = 0; k < terms.length; k++) { if (!ok(tokens[wtoks[i + k]], terms[k])) { good = false; break; } }
      if (good) { hits.push({ a: wtoks[i], b: wtoks[i + terms.length - 1] }); }
    }
    return hits;
  }

  /** words around a candidate for the review card: { before, hit, after, lead, trail, placeholder } */
  function buildContext(transcript, c, nBefore, nAfter, maxHit) {
    var words = (transcript && transcript.words) || [];
    nBefore = nBefore == null ? 5 : nBefore; nAfter = nAfter == null ? 5 : nAfter; maxHit = maxHit || 8;
    var idx = [], i;
    (c.words || []).forEach(function (x) { if (typeof x === 'number' && x >= 0 && x < words.length) { idx.push(x); } });
    var lo, hi, hit, placeholder = false;
    if (idx.length) {
      lo = Math.min.apply(null, idx); hi = Math.max.apply(null, idx);
      var take = [];
      for (i = lo; i <= hi && take.length < maxHit; i++) { take.push(String(words[i].w)); }
      hit = take.join(' ') + (hi - lo + 1 > maxHit ? ' \u2026' : '');
    } else {
      var a = 0, b = words.length;
      while (a < b) { var m = (a + b) >> 1; if (words[m].s < c.start - 1e-6) { a = m + 1; } else { b = m; } }
      lo = a; hi = a - 1; hit = placeholderText(c); placeholder = true;
    }
    var bf = [], af = [];
    for (i = Math.max(0, lo - nBefore); i < lo; i++) { bf.push(String(words[i].w)); }
    for (i = hi + 1; i < Math.min(words.length, hi + 1 + nAfter); i++) { af.push(String(words[i].w)); }
    return { before: bf.join(' '), hit: hit, after: af.join(' '), lead: lo - nBefore > 0, trail: hi + 1 + nAfter < words.length, placeholder: placeholder };
  }

  /* ---- virtual list: heights of the transcript blocks, measured when shown, estimated otherwise ---- */
  function VList(counts, perToken, minH) {
    this.counts = counts; this.n = counts.length;
    this.perToken = perToken || 3; this.minH = minH || 24;
    this.meas = []; this.h = []; this.pre = [0];
    for (var i = 0; i < this.n; i++) { this.meas.push(-1); }
    this.rebuild();
  }
  VList.prototype.estimate = function (i) { return Math.max(this.minH, Math.round(this.counts[i] * this.perToken)); };
  VList.prototype.rebuild = function () {
    this.pre = [0]; this.h = [];
    for (var i = 0; i < this.n; i++) {
      var h = this.meas[i] >= 0 ? this.meas[i] : this.estimate(i);
      this.h.push(h); this.pre.push(this.pre[i] + h);
    }
  };
  VList.prototype.measure = function (i, h) { if (h > 0 && i >= 0 && i < this.n) { this.meas[i] = h; } };
  VList.prototype.learn = function () {
    var sh = 0, sc = 0;
    for (var i = 0; i < this.n; i++) { if (this.meas[i] >= 0) { sh += this.meas[i]; sc += this.counts[i]; } }
    if (sc > 0) { this.perToken = sh / sc; }
    this.rebuild();
  };
  VList.prototype.resetMeasured = function () { for (var i = 0; i < this.n; i++) { this.meas[i] = -1; } this.rebuild(); };
  VList.prototype.offset = function (i) { return this.pre[clamp(i, 0, this.n)]; };
  VList.prototype.total = function () { return this.pre[this.n]; };
  VList.prototype.indexAt = function (y) {
    if (!this.n) { return -1; }
    var lo = 0, hi = this.n - 1, r = 0;
    y = Math.max(0, y);
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (this.pre[mid] <= y) { r = mid; lo = mid + 1; } else { hi = mid - 1; } }
    return r;
  };
  VList.prototype.range = function (top, bottom) { return { first: this.indexAt(top), last: this.indexAt(bottom) }; };

  /* ===========================================================================================
   * 2. styles
   * ========================================================================================= */
  var CSS = [
    '.cp-root{--cp-dead:#8fa3c4;--cp-dead-rgb:143,163,196;--cp-dead-text:#9db0d0;--cp-filler:var(--warn,#f5a524);--cp-filler-rgb:245,165,36;--cp-filler-text:var(--warn,#f5a524);--cp-stutter:#a78bfa;--cp-stutter-rgb:167,139,250;--cp-stutter-text:#b8a5fb;--cp-fstart:#f472b6;--cp-fstart-rgb:244,114,182;--cp-fstart-text:#f78fc5;--cp-nonword:#2dd4bf;--cp-nonword-rgb:45,212,191;--cp-nonword-text:#2dd4bf;--cp-manual:var(--accent,#4f8cff);--cp-manual-rgb:79,140,255;--cp-manual-text:#8db4ff;--cp-in-line:#6b717d;',
    'box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;overflow-x:hidden;overflow-y:auto;background:var(--panel,#1d1f23);color:var(--text,#e9eaee);font:12px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;outline:none;position:relative}',
    '.cp-root *,.cp-root *::before,.cp-root *::after{box-sizing:border-box}',
    '.cp-root [hidden]{display:none!important}',
    '.cp-root button,.cp-root input,.cp-root select{font:inherit;color:inherit}',
    '.cp-root .ico{width:14px;height:14px;flex:none;vertical-align:-2px}',
    '.cp-k-dead{--k:var(--cp-dead);--k-rgb:var(--cp-dead-rgb);--k-text:var(--cp-dead-text)}.cp-k-filler{--k:var(--cp-filler);--k-rgb:var(--cp-filler-rgb);--k-text:var(--cp-filler-text)}.cp-k-stutter{--k:var(--cp-stutter);--k-rgb:var(--cp-stutter-rgb);--k-text:var(--cp-stutter-text)}.cp-k-fstart{--k:var(--cp-fstart);--k-rgb:var(--cp-fstart-rgb);--k-text:var(--cp-fstart-text)}.cp-k-nonword{--k:var(--cp-nonword);--k-rgb:var(--cp-nonword-rgb);--k-text:var(--cp-nonword-text)}.cp-k-manual{--k:var(--cp-manual);--k-rgb:var(--cp-manual-rgb);--k-text:var(--cp-manual-text)}',
    '.cp-sec{border-bottom:1px solid var(--line,#33363d);padding:10px 12px;flex:none}',
    '.cp-h{display:flex;align-items:center;gap:8px;min-height:28px;flex-wrap:wrap}',
    '.cp-title{font-size:13px;font-weight:600;margin:0;flex:1 1 auto;min-width:0}',
    '.cp-sub{color:var(--muted,#9aa0ab);font-size:12px}',
    '.cp-summary{font-size:13px;font-weight:600;line-height:1.4;margin:6px 0 2px}',
    '.cp-note{margin:6px 0 0;padding:6px 8px;border-radius:6px;background:var(--panel-2,#25282d);border:1px solid var(--line,#33363d);color:var(--muted,#9aa0ab)}',
    '.cp-note.cp-warn{border-color:var(--warn,#f5a524);color:var(--text,#e9eaee)}',
    '.cp-note.cp-err{border-color:var(--danger,#ff5d5d);color:var(--text,#e9eaee)}',
    '.cp-note.cp-act{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.cp-note.cp-act .cp-ntext{flex:1 1 160px;min-width:0}',
    '.cp-note.cp-act .cp-nbtns{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}',
    '.cp-btn{min-height:28px;padding:4px 10px;border-radius:6px;border:1px solid var(--line,#33363d);background:var(--panel-2,#25282d);color:var(--text,#e9eaee);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;line-height:1.2;white-space:nowrap}',
    '.cp-btn:hover{background:var(--panel-3,#2d3036)}',
    '.cp-btn:disabled{opacity:.5;cursor:default}',
    '.cp-btn-primary{background:var(--accent,#4f8cff);border-color:var(--accent,#4f8cff);color:var(--accent-ink,#06101f);font-weight:600}',
    '.cp-btn-primary:hover{background:var(--accent,#4f8cff);filter:brightness(1.1)}',
    '.cp-btn-ok{background:var(--ok,#3ecf8e);border-color:var(--ok,#3ecf8e);color:var(--accent-ink,#06101f);font-weight:600}',
    '.cp-btn-ok:hover{background:var(--ok,#3ecf8e);filter:brightness(1.1)}',
    '.cp-btn-no{color:var(--danger,#ff5d5d)}',
    /* the general hover colour (panel-3) is only 4.39:1 under the red text: keep the resting colour and show the hover on the edge */
    '.cp-btn-no:hover{background:var(--panel-2,#25282d);border-color:var(--danger,#ff5d5d)}',
    '.cp-btn-ghost{background:transparent}',
    '.cp-btn-sm{padding:2px 8px}',
    '.cp-disc{display:flex;align-items:center;gap:6px;width:100%;min-height:28px;padding:2px 0;background:transparent;border:0;cursor:pointer;text-align:left;font-size:13px;font-weight:600}',
    '.cp-disc .cp-cnt{color:var(--muted,#9aa0ab);font-weight:400}',
    '.cp-body{padding:6px 0 2px}',
    '.cp-root button:focus-visible,.cp-root input:focus-visible,.cp-root select:focus-visible,.cp-root [tabindex]:focus-visible{outline:2px solid var(--accent,#4f8cff);outline-offset:1px}',
    '@supports not selector(:focus-visible){.cp-root button:focus,.cp-root input:focus,.cp-root select:focus,.cp-root [tabindex]:focus{outline:2px solid var(--accent,#4f8cff);outline-offset:1px}}',
    '.cp-set{display:grid;grid-template-columns:1fr;gap:8px}',
    '.cp-field{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:28px}',
    '.cp-field label{flex:1 1 150px}',
    '.cp-in{min-height:28px;padding:3px 6px;border-radius:6px;border:1px solid var(--cp-in-line);background:var(--bg,#16171a);color:var(--text,#e9eaee);width:64px}',
    '.cp-root input::placeholder{color:var(--muted,#9aa0ab);opacity:1}',
    '.cp-in.cp-wide{width:100%}',
    '.cp-check{display:flex;align-items:center;gap:8px;min-height:28px;cursor:pointer}',
    '.cp-check input{width:16px;height:16px;margin:0;accent-color:var(--accent,#4f8cff)}',
    '.cp-badge{display:inline-flex;align-items:center;min-height:20px;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap;color:var(--k-text,var(--text,#e9eaee));background:rgba(var(--k-rgb,255,255,255),.14);border:1px solid rgba(var(--k-rgb,255,255,255),.38)}',
    '.cp-queue{position:relative;max-height:min(46vh,430px);overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:2px}',
    '.cp-card{border:1px solid var(--line,#33363d);border-radius:8px;background:var(--panel-2,#25282d);padding:8px 10px;display:flex;flex-direction:column;gap:6px;outline:none}',
    '.cp-card-sel{border-color:var(--accent,#4f8cff);box-shadow:0 0 0 1px var(--accent,#4f8cff)}',
    '.cp-card-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.cp-time{min-height:28px;padding:2px 6px;border-radius:6px;border:0;background:transparent;color:var(--cp-manual-text);cursor:pointer;font-variant-numeric:tabular-nums}',
    '.cp-time:hover{background:var(--panel-3,#2d3036)}',
    '.cp-len{color:var(--muted,#9aa0ab);margin-left:auto;font-variant-numeric:tabular-nums}',
    '.cp-ctx{font-size:13px;line-height:1.5;color:var(--muted,#9aa0ab);overflow-wrap:anywhere;word-break:break-word}',
    '.cp-ctx mark{background:rgba(var(--k-rgb,255,255,255),.22);color:var(--text,#e9eaee);border-bottom:2px solid var(--k,var(--accent,#4f8cff));padding:0 3px;border-radius:3px;font-weight:600}',
    '.cp-confrow{display:flex;align-items:center;gap:8px}',
    '.cp-bar{flex:1;height:6px;border-radius:3px;background:var(--panel-3,#2d3036);overflow:hidden}',
    '.cp-fill{height:100%;border-radius:3px;background:var(--ok,#3ecf8e)}',
    '.cp-fill.cp-mid{background:var(--warn,#f5a524)}',
    '.cp-fill.cp-low{background:var(--danger,#ff5d5d)}',
    '.cp-pct{min-width:64px;text-align:right;color:var(--muted,#9aa0ab);font-variant-numeric:tabular-nums}',
    '.cp-reason{margin:0;color:var(--text,#e9eaee)}',
    '.cp-actions{display:flex;gap:6px;flex-wrap:wrap}',
    '.cp-actions .cp-btn{flex:1 1 70px}',
    '.cp-bulk{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}',
    '.cp-empty{padding:10px;border:1px dashed var(--line,#33363d);border-radius:8px;color:var(--muted,#9aa0ab);text-align:center}',
    '.cp-keys{margin:8px 0 0;color:var(--muted,#9aa0ab)}',
    '.cp-keys kbd{font:inherit;font-size:12px;padding:0 5px;border-radius:4px;border:1px solid var(--line,#33363d);background:var(--panel-3,#2d3036);color:var(--text,#e9eaee)}',
    '.cp-rows{display:flex;flex-direction:column;gap:4px}',
    '.cp-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 6px;border:1px solid var(--line,#33363d);border-radius:6px;background:var(--panel-2,#25282d)}',
    '.cp-rtext{flex:1 1 90px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cp-rbtns{display:flex;gap:4px;margin-left:auto}',
    '.cp-search{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0}',
    '.cp-search .cp-in{flex:1 1 140px;width:auto}',
    '.cp-hitcount{color:var(--muted,#9aa0ab);min-width:48px;text-align:center;font-variant-numeric:tabular-nums}',
    '.cp-tx{position:relative;border:1px solid var(--line,#33363d);border-radius:8px;background:var(--bg,#16171a)}',
    '.cp-tscroll{position:relative;height:300px;min-height:160px;overflow-y:auto;padding:8px 10px;font-size:13px;line-height:28px;outline:none;resize:vertical}',
    '.cp-chunk{display:block;box-sizing:border-box;padding-bottom:6px;overflow-wrap:anywhere;word-break:break-word}',
    '.cp-w{cursor:pointer;border-radius:3px;padding:1px 1px;-webkit-user-select:none;user-select:none;border-bottom:2px solid transparent}',
    '.cp-w:hover{background:var(--panel-3,#2d3036)}',
    '.cp-gap{color:var(--muted,#9aa0ab);font-size:12px;border:1px dashed var(--line,#33363d);padding:0 4px;margin:0 1px;border-radius:4px}',
    '.cp-w.cp-pend{background:rgba(var(--k-rgb,255,255,255),.18);border-bottom:2px dotted var(--k,var(--warn,#f5a524));color:var(--text,#e9eaee)}',
    '.cp-w.cp-app{background:rgba(var(--k-rgb,255,255,255),.1);border-bottom:2px solid var(--k,var(--muted,#9aa0ab))}',
    '.cp-w.cp-rej{border-bottom:2px dotted var(--line,#33363d)}',
    '.cp-w.cp-cut{text-decoration:line-through;color:var(--muted,#9aa0ab)}',
    '.cp-w.cp-fc{outline:2px solid var(--text,#e9eaee);outline-offset:1px}',
    '.cp-w.cp-hit{outline:1px solid var(--warn,#f5a524)}',
    '.cp-w.cp-hitc{outline:2px solid var(--warn,#f5a524);background:var(--panel-3,#2d3036)}',
    '.cp-w.cp-sel{background:var(--panel-3,#2d3036);outline:1px solid var(--accent,#4f8cff)}',
    '.cp-w.cp-now{background:var(--accent,#4f8cff);color:var(--accent-ink,#06101f);border-radius:3px}',
    '.cp-float{position:static;margin:6px 8px 8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;border-radius:8px;border:1px solid var(--accent,#4f8cff);background:var(--panel,#1d1f23)}',
    '.cp-float .cp-sub{flex:1 1 100px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cp-hint{margin:6px 0 0;color:var(--muted,#9aa0ab)}',
    /* minmax(0,1fr): a plain 1fr column cannot be narrower than its widest row, which pushed the buttons out of a narrow panel */
    '.cp-form{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}',
    '.cp-form .cp-field{flex-wrap:wrap}',
    '.cp-form .cp-in{flex:1;width:auto;min-width:0}',
    '.cp-form-msg{min-height:18px;color:var(--danger,#ff5d5d);margin:0}',
    '.cp-form-msg.cp-okmsg{color:var(--ok,#3ecf8e)}',
    /* cleanup level: one compact segmented control (real radio buttons) and one help line for the chosen level */
    '.cp-level{border:0;margin:0;padding:0;min-width:0}',
    '.cp-level legend{padding:0;margin:0 0 4px;font-size:13px;font-weight:600;max-width:100%;overflow-wrap:anywhere}',
    '.cp-seg{display:flex;width:100%;min-width:0;border:1px solid var(--cp-in-line);border-radius:8px;overflow:hidden;background:var(--panel-2,#25282d)}',
    '.cp-seg:focus-within{outline:2px solid var(--accent,#4f8cff);outline-offset:2px}',
    '.cp-seg-opt{position:relative;flex:1 1 0;min-width:0;min-height:30px;display:flex;align-items:center;justify-content:center;margin:0;padding:4px 6px;cursor:pointer;text-align:center;line-height:1.2;overflow-wrap:anywhere;color:var(--text,#e9eaee);background:var(--panel-2,#25282d)}',
    '.cp-seg-opt+.cp-seg-opt{border-left:1px solid var(--cp-in-line)}',
    '.cp-seg-opt:hover{background:var(--panel-3,#2d3036)}',
    '.cp-seg-opt.cp-on{background:var(--accent,#4f8cff);color:var(--accent-ink,#06101f);font-weight:600}',
    '.cp-seg-opt input{position:absolute;top:0;left:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}',
    '.cp-seg-help{margin:6px 0 0;color:var(--muted,#9aa0ab);overflow-wrap:anywhere}',
    '.cp-level-note{margin:2px 0 0;min-height:18px;color:var(--text,#e9eaee);overflow-wrap:anywhere}',
    '.cp-adv{margin-top:2px;border-top:1px solid var(--line,#33363d);padding-top:4px}',
    /* queue filter chips, bulk buttons and the tip */
    '.cp-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0}',
    '.cp-chip{min-height:28px;max-width:100%;padding:2px 10px;border-radius:14px;border:1px solid var(--cp-in-line);background:var(--panel-2,#25282d);color:var(--text,#e9eaee);cursor:pointer;display:inline-flex;align-items:center;gap:6px;line-height:1.2;white-space:nowrap}',
    '.cp-chip:hover{background:var(--panel-3,#2d3036)}',
    '.cp-chip-n{font-variant-numeric:tabular-nums;color:var(--muted,#9aa0ab)}',
    '.cp-chip[aria-pressed="true"]{background:var(--accent,#4f8cff);border-color:var(--accent,#4f8cff);color:var(--accent-ink,#06101f);font-weight:600}',
    '.cp-chip[aria-pressed="true"] .cp-chip-n{color:var(--accent-ink,#06101f)}',
    '.cp-bulk-top{margin:8px 0 0}',
    '.cp-tip{margin:8px 0 0;color:var(--muted,#9aa0ab);overflow-wrap:anywhere}',
    /* the "Create transcript" card */
    '.cp-create{margin:8px 0 0;padding:12px;border:1px solid var(--accent,#4f8cff);border-radius:10px;background:var(--panel-2,#25282d);display:flex;flex-direction:column;gap:8px;min-width:0}',
    '.cp-create-h{margin:0;font-size:14px;font-weight:600}',
    '.cp-cmsg{margin:0;padding:6px 8px;border-radius:6px;background:var(--panel,#1d1f23);border:1px solid var(--line,#33363d);color:var(--text,#e9eaee)}',
    '.cp-cmsg.cp-warn{border-color:var(--warn,#f5a524)}',
    '.cp-cmsg.cp-okn{border-color:var(--ok,#3ecf8e)}',
    '.cp-create p{margin:0;overflow-wrap:anywhere}',
    '.cp-create .cp-btn-primary{width:100%;min-height:36px;white-space:normal}',
    '.cp-link{align-self:flex-start;min-height:28px;max-width:100%;padding:2px 0;border:0;background:transparent;color:var(--cp-manual-text);text-decoration:underline;cursor:pointer;text-align:left;line-height:1.3}',
    '.cp-link:hover{color:var(--text,#e9eaee)}',
    '.cp-steps{margin:0;padding-left:22px;overflow-wrap:anywhere}',
    '.cp-steps li{margin:0 0 4px;padding-left:2px}',
    '.cp-stage{font-weight:600}',
    '.cp-prog{height:8px;border-radius:4px;background:var(--panel-3,#2d3036);overflow:hidden}',
    '.cp-prog-fill{height:100%;width:0;border-radius:4px;background:var(--accent,#4f8cff)}',
    /* the reason under a disabled button: normal text, not faded */
    '.cp-why{margin:0;color:var(--text,#e9eaee)}',
    '.cp-create-part .cp-why{margin-top:6px}',
    /* the header's "Engines" line: one line, the rest behind "details" */
    '.cp-engines{display:flex;align-items:center;gap:6px;min-width:0}',
    '.cp-engines-t{flex:1 1 auto;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cp-engines .cp-link{flex:none;align-self:center}',
    '.cp-engines.cp-open{align-items:flex-start}',
    '.cp-engines.cp-open .cp-engines-t{white-space:normal;overflow-wrap:anywhere}',
    '.cp-engines.cp-open .cp-link{align-self:flex-start}',
    '.cp-create .cp-nbtns,.cp-create-btns{display:flex;gap:6px;flex-wrap:wrap}'
  ].join('\n');

  /* ===========================================================================================
   * 3. the panel
   * ========================================================================================= */
  function create(options) {
    options = options || {};
    var host = options.host, api = options.api || {}, Engine = options.Cleanup;
    if (!host || !host.ownerDocument) { throw new Error('CleanupPanel.create needs a host element.'); }
    if (!Engine || typeof Engine.analyze !== 'function' || typeof Engine.parseTranscript !== 'function') {
      throw new Error('CleanupPanel.create needs the Cleanup analysis engine (options.Cleanup).');
    }
    var doc = host.ownerDocument;
    var win = doc.defaultView || {};
    var D = Engine.DEFAULTS || {};
    var destroyed = false, busy = 0, dirtyWhileBusy = false, batchDepth = 0;
    var timers = {}, offs = [];
    var E = {};                       // element references
    var cardEls = new Map();          // candidate id -> card element
    var btnLabels = new Map();        // button -> its label element (so a label can change without touching the icon)
    var V = { vl: null, chunks: [], chunkEls: [], rendered: {}, tokEl: {}, chunkOfTok: [], perToken: 3, lastW: 0 };
    var drag = null;
    var uid = ++instanceCount;
    var tcClient = null, jobSeq = 0;  // the helper client (made on first use) and the number of the current / last job
    var wordIdx = null;               // sorted index of the transcript words (wordsBetween)
    var heldMemo = null;              // heldIds(): the ids of the held transcript's cards at every level, for the settings they were found with

    var DEF = {
      minGap: num(D.minGap, 0.8), keepPause: num(D.keepPause, 0.35), autoPct: Math.round(num(D.autoThreshold, 0.85) * 100),
      deadSpace: D.includeDeadSpace !== false, ums: D.includeFillers !== false, stutters: D.includeStutters !== false,
      nonWords: D.includeNonWords !== false, fillerWords: ''
    };
    var DEFAULT_FILLERS = Array.isArray(D.fillers) ? D.fillers.slice() : ['um', 'uh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm', 'uhm', 'umm', 'uhh', 'eh'];
    var PAD = num(D.pad, 0.02);

    var S = {
      transcript: null, format: '', warnings: [], tid: '',
      tokens: [], wtoks: [], wordTok: [], chipTok: {}, tokCand: [], candToks: [], cutFlags: [], hitFlag: [],
      settings: null, decisions: [], candidates: [], candById: {}, stats: null,
      links: [], known: {}, strays: {}, shadow: {}, pageMade: new WeakSet(), ties: {}, analysisWarnings: [],
      selCard: '', selStart: 0, selA: -1, selB: -1, anchor: -1,
      undo: [], ui: null, cur: -1,
      hits: [], hitCur: -1, query: '',
      lastUserScroll: 0, storageWarned: false, decisionsUnsaved: false, error: '',
      dormant: null, savedTid: '', forVideo: null,
      filter: 'all', levelNoteOn: false, source: null, job: null, createOpen: false,
      setPin: null,                  // Settings: null = automatic (open only while no transcript is loaded), else what the user chose since
      enginesOpen: false,            // the header's Engines line is shown in full
      engineText: ''                 // what the Engines line says
    };

    /* ---------------- small wrappers around the page api ---------------- */
    function safe(fn, fallback) { try { var v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } }
    function duration() { return safe(function () { return num(api.getDuration(), 0); }, 0); }
    function videoName() { return safe(function () { return typeof api.getVideoName === 'function' ? String(api.getVideoName() || '') : ''; }, ''); }
    function videoNow() { return { name: videoName(), duration: duration() }; }
    function fps() { var f = safe(function () { return num(api.getFps(), 0); }, 0); return f >= 1 && f <= 480 ? f : 0; }
    function toast(msg) { try { if (typeof api.toast === 'function') { api.toast(msg); } } catch (e) { /* ignore */ } }
    function ask(msg) {
      try {
        if (typeof api.confirm === 'function') { return !!api.confirm(msg); }
        if (typeof win.confirm === 'function') { return !!win.confirm(msg); }
      } catch (e) { return false; }
      return true;
    }
    function seekTo(t) { safe(function () { return api.seek(t); }); }
    function playRange(t0, t1) {
      if (typeof api.playRange === 'function') { safe(function () { return api.playRange(t0, t1); }); } else { seekTo(t0); }
    }
    // one api.batch call is one step in the page's history; a batch inside a batch is simply part of the outer one
    function batch(fn) {
      busy++;
      try {
        if (typeof api.batch === 'function' && batchDepth === 0) { batchDepth++; try { api.batch(fn); } finally { batchDepth--; } } else { fn(); }
      }
      finally { busy--; }
    }
    function sget(key) { try { return api.storage && typeof api.storage.get === 'function' ? api.storage.get(key) : null; } catch (e) { return null; } }
    function sset(key, val) { try { if (!api.storage || typeof api.storage.set !== 'function') { return false; } return api.storage.set(key, val) !== false; } catch (e) { return false; } }
    function jget(key) { var raw = sget(key); if (!raw || typeof raw !== 'string') { return null; } try { return JSON.parse(raw); } catch (e) { return null; } }
    function jset(key, obj) { var s; try { s = JSON.stringify(obj); } catch (e) { return false; } return sset(key, s); }
    function schedule(fn) {
      if (typeof win.requestAnimationFrame === 'function') { return win.requestAnimationFrame(fn); }
      return setTimeout(fn, 16);
    }
    function later(name, ms, fn) {
      if (timers[name]) { clearTimeout(timers[name]); }
      timers[name] = setTimeout(function () { timers[name] = null; if (!destroyed) { fn(); } }, ms);
    }

    /* ---------------- DOM helpers ---------------- */
    function h(tag, attrs, kids) {
      var el = doc.createElement(tag), k, v, i;
      if (attrs) {
        for (k in attrs) {
          if (!Object.prototype.hasOwnProperty.call(attrs, k)) { continue; }
          v = attrs[k];
          if (v === null || v === undefined || v === false) { continue; }
          if (k === 'class') { el.className = v; } else if (k === 'text') { el.textContent = v; } else { el.setAttribute(k, v === true ? '' : String(v)); }
        }
      }
      if (kids) {
        for (i = 0; i < kids.length; i++) {
          var kid = kids[i];
          if (kid === null || kid === undefined || kid === false) { continue; }
          el.appendChild(typeof kid === 'string' ? doc.createTextNode(kid) : kid);
        }
      }
      return el;
    }
    function on(el, type, fn) { el.addEventListener(type, fn); return el; }
    function icon(name) {
      var svg = doc.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'ico'); svg.setAttribute('aria-hidden', 'true');
      var use = doc.createElementNS(SVGNS, 'use');
      use.setAttribute('href', '#i-' + name);
      svg.appendChild(use);
      return svg;
    }
    function btn(label, cls, handler, iconName, title) {
      var b = h('button', { type: 'button', 'class': 'cp-btn' + (cls ? ' ' + cls : ''), title: title });
      if (iconName) { b.appendChild(icon(iconName)); }
      var lab = h('span', { text: label });
      b.appendChild(lab);
      btnLabels.set(b, lab);
      on(b, 'click', handler);
      return b;
    }
    function setBtnLabel(b, label) { var lab = btnLabels.get(b); if (lab && lab.textContent !== label) { lab.textContent = label; } }
    function clearEl(el) { while (el.firstChild) { el.removeChild(el.firstChild); } }
    function setHidden(el, hidden) { if (el) { el.hidden = !!hidden; } }
    function kindInfo(kind) {
      var info = null;
      try { if (typeof Engine.describeKind === 'function') { info = Engine.describeKind(kind); } } catch (e) { info = null; }
      var fb = KIND_FALLBACK[kind] || { label: String(kind), help: '' };
      return { label: (info && info.label) || fb.label, help: (info && info.help) || fb.help };
    }
    function kindClass(kind) { return KIND_CLASS[kind] || 'cp-k-dead'; }

    /* ---------------- cleanup level ---------------- */
    function readLevels() {
      var src = Engine.LEVELS, out = [];
      if (!Array.isArray(src)) { return out; }
      src.forEach(function (l) { if (l && typeof l.id === 'string' && l.id) { out.push({ id: l.id, label: String(l.label || l.id), help: String(l.help || '') }); } });
      return out;
    }
    var LEVELS = readLevels();        // read once: an engine does not change its levels while the panel is open
    function levelsOn() { return LEVELS.length > 0; }
    function levelById(id) { for (var i = 0; i < LEVELS.length; i++) { if (LEVELS[i].id === id) { return LEVELS[i]; } } return null; }
    /** a stored level that this engine knows, else Balanced (or the engine's first level when it has no Balanced) */
    function validLevel(id) {
      if (typeof id === 'string' && id && (!levelsOn() || levelById(id))) { return id; }
      return levelsOn() && !levelById(DEFAULT_LEVEL) ? LEVELS[0].id : DEFAULT_LEVEL;
    }
    /** the "apply automatically" limit (percent) the engine itself uses for a level: Thorough is a little lower */
    function levelAutoPct(id) {
      var pre = levelsOn() && Engine.PRESETS && typeof Engine.PRESETS === 'object' ? Engine.PRESETS[id] : null;
      var v = pre && typeof pre.autoThreshold === 'number' ? pre.autoThreshold : NaN;
      return isFinite(v) ? Math.round(clamp(v * 100, NUM_LIMITS.autoPct[0], NUM_LIMITS.autoPct[1])) : DEF.autoPct;
    }

    /* ---------------- settings ---------------- */
    function normalizeSettings(o) {
      o = o && typeof o === 'object' ? o : {};
      var level = validLevel(o.level);
      var typed = Math.round(clamp(num(o.autoPct, DEF.autoPct), NUM_LIMITS.autoPct[0], NUM_LIMITS.autoPct[1]));
      // a confidence limit the user chose is kept; otherwise it follows the level. A record from before levels existed has no
      // flag: a value other than the standard one was typed by the user, the standard one just came with the settings.
      var own = o.autoPctSet === true || (o.autoPctSet === undefined && o.autoPct !== undefined && typed !== DEF.autoPct);
      var s = {
        minGap: clamp(num(o.minGap, DEF.minGap), NUM_LIMITS.minGap[0], NUM_LIMITS.minGap[1]),
        keepPause: clamp(num(o.keepPause, DEF.keepPause), NUM_LIMITS.keepPause[0], NUM_LIMITS.keepPause[1]),
        autoPct: own ? typed : levelAutoPct(level),
        autoPctSet: own,
        level: level,
        deadSpace: o.deadSpace === undefined ? DEF.deadSpace : !!o.deadSpace,
        ums: o.ums === undefined ? DEF.ums : !!o.ums,
        stutters: o.stutters === undefined ? DEF.stutters : !!o.stutters,
        nonWords: o.nonWords === undefined ? DEF.nonWords : !!o.nonWords,
        fillerWords: typeof o.fillerWords === 'string' ? o.fillerWords.slice(0, 2000) : ''
      };
      return s;
    }
    function analysisParams() {
      var p = {}, k, s = S.settings;
      // With levels, only the settings shown in the panel are passed, so that the level's own defaults are not overridden by a
      // copy of every default. Without levels (an older engine) the engine's defaults are passed as before.
      if (levelsOn()) { p.level = s.level; }
      else { for (k in D) { if (Object.prototype.hasOwnProperty.call(D, k)) { p[k] = D[k]; } } }
      p.minGap = s.minGap; p.keepPause = s.keepPause; p.autoThreshold = s.autoPct / 100;
      p.includeDeadSpace = s.deadSpace; p.includeFillers = s.ums; p.includeStutters = s.stutters; p.includeNonWords = s.nonWords;
      if (s.fillerWords) { p.fillers = parseFillerList(s.fillerWords); }
      return p;
    }
    function fillerText() { return S.settings.fillerWords || DEFAULT_FILLERS.join(', '); }

    /* ---------------- persistence ---------------- */
    function persistSettings() { jset(KEYS.settings, S.settings); }
    function persistUi() { S.ui.uiv = 4; jset(KEYS.ui, S.ui); }
    function persistDecisions() {
      if (!S.tid) { return; }
      S.decisionsUnsaved = !jset(KEYS.decisions, { tid: S.tid, list: S.decisions });
    }
    // with no transcript open, the links keep the id they were saved with, so the same file can pick them up again
    function persistKnown() { if (S.dormant) { return; } jset(KEYS.links, { tid: S.tid || S.savedTid || '', map: S.known }); }
    /** where the transcript came from, as far as the panel remembers it: made by the helper, or a file with a name */
    function cleanSource(s) {
      if (!s || typeof s !== 'object') { return null; }
      if (s.kind === 'helper') { return { kind: 'helper' }; }
      if (s.kind === 'file' && typeof s.name === 'string' && s.name) { return { kind: 'file', name: clip(s.name, 120) }; }
      return null;
    }
    function persistTranscript() {
      if (!S.transcript) { sset(KEYS.transcript, ''); return; }
      var rec = { tid: S.tid, format: S.format, warnings: S.warnings, transcript: S.transcript, forVideo: S.forVideo };
      if (S.source) { rec.source = S.source; }
      var ok = jset(KEYS.transcript, rec);
      if (!ok) {
        sset(KEYS.transcript, '');
        if (!S.storageWarned) { S.storageWarned = true; renderNotes(); }
      }
    }

    /* ---------------- the page's cuts ---------------- */
    function sameMarker(c, k) {
      if (!c || !k) { return false; }
      var o = c.origin;
      if (k.cid && o && o.candidateId === k.cid) { return true; }
      var tol = Math.max(0.05, fps() ? 1.5 / fps() : 0);
      return Math.abs(c.start - k.start) <= tol && Math.abs(c.end - k.end) <= tol;
    }
    /** the page's cuts; anything in the list that is not an object (a null from a page with a bug, a number) is not a cut and is left out, so no reader has to check */
    function getCutsSafe() {
      var c = safe(function () { return api.getCuts(); }, []);
      return Array.isArray(c) ? c.filter(function (x) { return !!x && typeof x === 'object'; }) : [];
    }
    function scanLinks() {
      var cuts = getCutsSafe(), out = [];
      for (var i = 0; i < cuts.length; i++) {
        var c = cuts[i];
        if (!c || !isFinite(c.start) || !isFinite(c.end)) { continue; }
        var o = c.origin && typeof c.origin === 'object' ? c.origin : null;
        var k = S.known[c.id];
        if (k && !sameMarker(c, k)) { k = null; }   // a different marker that reuses the id
        var own = !!k || (o && (o.by === 'cleanup-panel' || typeof o.candidateId === 'string'));
        if (!own) { continue; }
        out.push({
          id: c.id, kind: (o && o.kind) || (k && k.kind) || 'manual', start: +c.start, end: +c.end,
          auto: o ? !!o.auto : !!(k && k.auto), cid: (o && o.candidateId) || (k && k.cid) || '',
          comment: c.comment || '', confidence: o ? o.confidence : undefined, reason: o ? o.reason : '',
          by: (o && typeof o.by === 'string') ? o.by : '', known: !!k,        // known: the panel itself made or matched this cut earlier
          card: (k && k.card) || S.ties[c.id] || ''                          // the card it was tied to when it fitted only by overlap (page undo of a change of "Leave a pause of"), or by a decision of panel 1.0.0 (completeOldDecisions)
        });
      }
      out.sort(function (a, b) { return a.start - b.start; });
      return out;
    }
    /**
     * remember the panel's cuts. Automatic cuts that fit no card and that the panel did not make itself (S.strays: those of a
     * loaded session made from another transcript) are left out: the panel does not "know" them, so it never removes them and
     * never writes a decision when they disappear. With no transcript nothing new is remembered, for the same reason.
     */
    function rememberLinks(links) {
      var map = {};
      links.forEach(function (l) {
        if (S.strays[l.id]) { return; }
        if (!S.transcript && !l.known) { return; }      // with no transcript a cut that came with a loaded session stays a stranger, as it does when the transcript was open first
        map[l.id] = { kind: l.kind, start: l.start, end: l.end, auto: l.auto, cid: l.cid };
        if (l.card) { map[l.id].card = l.card; }
      });
      S.known = map;
    }
    function removeCutSafe(l) {
      busy++;
      try { api.removeCut(l.id); } catch (e) { /* ignore */ }
      finally { busy--; }
      delete S.known[l.id];
    }
    function commentFor(c) {
      var what = c.text && /^\[/.test(c.text) ? c.text : c.text ? '\u201c' + clip(c.text, 60) + '\u201d' : formatLen(c.end - c.start);
      return kindInfo(c.kind).label + ': ' + what;
    }
    /** add a cut for a candidate. Returns the marker id, or null when the page refused. */
    function addCutFor(c, auto) {
      var d = duration(), f = fps();
      var start = Math.max(0, c.start), end = d > 0 ? Math.min(d, c.end) : c.end;
      var minLen = f ? 1 / f : 0.02;
      if (end - start < Math.min(minLen, 0.02)) { return null; }
      var payload = {
        start: start, end: end, comment: commentFor(c),
        origin: { kind: c.kind, confidence: c.confidence, auto: !!auto, candidateId: c.id, reason: c.reason || '', by: 'cleanup-panel' }
      };
      var id;
      busy++;
      try { id = api.addCut(payload); } catch (e) { id = null; }
      finally { busy--; }
      if (id === undefined || id === null || id === false) { return null; }
      S.known[id] = { kind: c.kind, start: start, end: end, auto: !!auto, cid: c.id };
      return id;
    }

    /** what reconcileNow does with the cuts that came back through the page, by the mode it is called in (the parts of planReconcile's follow; the list is in reconcileNow's note below) */
    function followRules(mode) {
      var unknownAuto = function (l) { return l.auto && !l.known; };
      // while following the page every automatic cut is left alone on a card that waits or was rejected, also one the panel itself kept for the
      // card while it was accepted (a returned automatic cut on an accepted card): when the card then falls back to waiting (the page undid its
      // Accept), taking that cut out would be a new step in the page's history
      var anyAuto = function (l) { return l.auto; };
      var follow = {};
      if (mode !== 'settings') { follow.pending = mode === 'page' ? anyAuto : unknownAuto; }
      if (mode === 'page') { follow.unknown = anyAuto; follow.moved = true; follow.extra = true; follow.duplicates = true; }
      else if (mode === 'restore') { follow.tied = true; follow.extra = true; follow.own = true; }
      else if (mode === 'decision') { follow.ownAccept = true; follow.rejected = true; follow.ownTied = true; }
      else if (mode === 'settings') { follow.ownSame = true; }      // an accepted cut tied to its card (made by panel 1.0.0) stays where it is while the card is the same one
      else { follow.own = true; }      // a transcript was opened: the user's accepted cuts that are on the timeline already stay where they are
      return follow;
    }
    /**
     * make the page's cuts match the candidates' states. Returns the plan; S.links is refreshed.
     * An automatic cut that fits no candidate is removed only when the panel made it itself (it is in S.known). One it never knew
     * stays. A cut that fits no candidate and that the panel never knew (S.strays) is not remembered either: when it goes away, no
     * decision is written for it. keepAll: every automatic cut that fits no candidate stays (a transcript was opened while the panel had none).
     * An automatic cut the panel never knew that is on a card which needs a decision also stays (the page brought it back with undo,
     * redo or a loaded session; Accept keeps it, Reject takes it out). fromPage (refreshMarkers): the panel only follows the page, so
     * it changes nothing there: that holds for such cuts on a rejected card, and for a cut that fits its card only by overlap.
     * mode: 'page' (refreshMarkers, as above), 'decision' (the user decided something: an automatic cut that sits on a card the user
     * has accepted is swapped for a cut that records the Accept, because the page keeps who made a cut and page undo, redo and a
     * loaded session read the Accept from it), 'settings' (the user changed a setting: the page is made to match the new settings, so
     * an automatic cut the panel never knew is taken out of a card that now needs a decision too, as a fresh panel would not have it; an
     * accepted cut that is tied to its card (panel 1.0.0 made it) stays while the card is the same one), 'restore' (the panel starts again
     * from storage: a cut it had tied to a card that moved, because the page undid a change of "Leave a pause of", stays as it is, so a page
     * reload makes no page call), anything else: a transcript was opened.
     * announce (refreshMarkers({ loaded: true }) after a session was loaded): a toast says how many automatic cuts were added that the
     * session did not have.
     */
    function reconcileNow(keepAll, mode, announce) {
      var links = scanLinks();
      var follow = followRules(mode);
      var plan = planReconcile(S.candidates, links, Math.max(DECISION_TOL, fps() ? 1.5 / fps() : 0), function (l) { return keepAll === true || !l.known; }, follow);
      if (mode === 'page' && !announce) { followPlan(plan); }
      S.strays = {};
      plan.strays.forEach(function (l) { S.strays[l.id] = true; });
      plan.orphans.forEach(function (l) { if (l.kind !== 'manual' && (keepAll === true || !l.known)) { S.strays[l.id] = true; } });      // an accepted cut that fits no card and is not the panel's own
      var refused = 0, added = 0;
      function refuse(c) {
        if (c.st === 'accepted') { removeDecision(S.decisions, c.kind, c.start, c.end); }
        c.failed = true; c.st = 'pending'; refused++;
      }
      if (plan.add.length || plan.remove.length || plan.swaps.length) {
        batch(function () {
          plan.remove.forEach(function (l) { removeCutSafe(l); });
          plan.add.forEach(function (c) {
            var id = addCutFor(c, c.st === 'auto');
            if (id === null) { refuse(c); } else if (c.st === 'auto') { added++; }
          });
          plan.swaps.forEach(function (s) {
            // only who made the cut changes: its range and its note stay as they are (the user may have trimmed it or written on it);
            // except a cut that fits its card by overlap alone and shows no edit of the user's: the Accept makes the card's own cut
            var sp = specOf(s.link), id = null, own = keepsOwnCut(s);
            removeCutSafe(s.link);
            if (own) {
              sp.origin = { kind: s.cand.kind, confidence: s.cand.confidence, auto: false, candidateId: s.cand.id, reason: s.cand.reason || '', by: 'cleanup-panel' };
              busy++;
              try { id = api.addCut(sp); } catch (e) { id = null; }
              finally { busy--; }
            } else { id = addCutFor(s.cand, false); }
            if (id === undefined || id === null || id === false) { readdSpec(specOf(s.link)); refuse(s.cand); }      // the page said no: the cut that was there stays
            else if (own) { S.known[id] = { kind: s.cand.kind, start: sp.start, end: sp.end, auto: false, cid: s.cand.id }; }
          });
        });
      }
      // said first, so that a page which shows one toast at a time still shows the refusal below
      if (announce && added) { toast('Audio cleanup added ' + added + ' automatic ' + plural(added, 'cut', 'cuts') + ' that the session did not have.'); }
      if (refused) { toast('The page could not add ' + refused + ' ' + plural(refused, 'cut', 'cuts') + '. ' + plural(refused, 'It is', 'They are') + ' listed under "Needs your decision" instead.'); }
      S.links = scanLinks();
      var tie = {};      // a cut that was kept because it overlaps its card (the card moved) stays tied to that card: if the user then trims it, it is still that card's cut
      plan.keep.forEach(function (kp) { if (kp.moved) { tie[kp.link.id] = kp.cand.id; } });
      S.links.forEach(function (l) { if (tie[l.id]) { l.card = tie[l.id]; } });
      rememberLinks(S.links);
      S.ties = {};
      dirtyWhileBusy = false;
      return plan;
    }
    function reclassify() { S.candidates.forEach(function (c) { c.st = stateFromDecision(c, S.decisions); }); }
    /**
     * refreshMarkers() only follows the page: whatever the rules above leave in the plan, it adds and takes out no cut (that is a new step in
     * the page's history, which cuts off its redo steps, and the page's undo would never get past it). The rules are meant to leave nothing
     * here; if a state they did not think of still does, the page is right and the panel's card follows it, as syncExternal does for a cut
     * that went away: a card that should have a cut and has none is recorded as taken away (a card that waits for a decision goes back
     * to waiting), and a cut the plan would take out stays where it is (the next action of the user's own cleans it up).
     */
    function followPlan(plan) {
      plan.add.forEach(function (c) {
        if (c.st === 'accepted' && c.eff !== 'auto') { removeDecision(S.decisions, c.kind, c.start, c.end); }
        else { rejectByPage(c.kind, c.start, c.end); }
        c.st = stateFromDecision(c, S.decisions);
      });
      plan.add = [];
      plan.remove.forEach(function (l) { (l.auto ? plan.strays : plan.orphans).push(l); });
      plan.remove = [];
    }

    /**
     * A Reject the panel writes by itself while it follows the page (a cut went away, a card has no cut): the page took the cut, the user
     * did not decide anything about the card. It is remembered as such until the user does something in the panel, because a cut that
     * comes back over it must not keep it aside (S.shadow): it would be given back later as if the user had rejected the card.
     */
    function rejectByPage(kind, start, end) {
      var was = getDecision(S.decisions, kind, start, end), theirs = !!was && was.d === 'reject';      // a Reject that is there already is not made by this
      setDecision(S.decisions, kind, start, 'reject', end);
      var r = getDecision(S.decisions, kind, start, end);
      if (r && r.d === 'reject' && !theirs) { S.pageMade.add(r); }
    }
    /** a Reject that a returned cut takes the place of, as it was recorded, to be kept aside (S.shadow); null for something that is no Reject of the user's */
    function asideRecord(r) { return r && r.d === 'reject' && !S.pageMade.has(r) ? { kind: r.kind, start: r.start, end: r.end } : null; }

    /** the ids of the automatic cuts the panel knows that are no longer in the page (byId: the page's cuts by id) */
    function goneAuto(byId) {
      var gone = [];
      Object.keys(S.known).forEach(function (id) {
        var k = S.known[id], c = byId[id];
        if (!(c && sameMarker(c, k)) && k.kind !== 'manual' && k.auto !== false) { gone.push(id); }
      });
      return gone;
    }
    /**
     * refreshMarkers({ loaded: true }): has the page just loaded a session that leaves out automatic cuts of this transcript? Only then does
     * the call differ from a plain one. The session replaced all the page's cuts, so a cut it lacks was not deleted by the user: it is
     * not a Reject, and its card (still applied on its own) gets the cut back. Not when most of the page's panel cuts fit no card of this
     * transcript (the measure of the question when a transcript is opened): that session is from another transcript, and the call is a plain one.
     */
    function sessionLacksOwn() {
      var byId = {};
      getCutsSafe().forEach(function (c) { if (c) { byId[c.id] = c; } });
      if (!goneAuto(byId).length) { return false; }
      var fit = misfitCuts(S.transcript);
      return !(fit.bad > 0 && fit.bad * 2 > fit.total);
    }

    /**
     * Which of the cuts that have vanished from the page were swapped for others rather than deleted: an automatic cut whose card now has
     * a cut of the same kind with another id that the panel does not know (a loaded session gives every cut a new id; page undo of a
     * change of "Leave a pause of" puts the cuts of the old pauses back). Nothing is recorded as rejected for those: the card has its cut.
     * Returns { ids: the swapped ones, lacking: how many other cuts vanished in the same refresh }. A cut that is missing from a
     * timeline that was replaced like that can only be read as removed (the panel makes no cut while it follows the page), so it is
     * recorded as rejected, as before; the count lets the user be told.
     */
    function swappedOut(byId) {
      var gone = goneAuto(byId), ids = {}, fresh = [], n = 0, links = scanLinks(), held = null;
      if (!gone.length) { return { ids: ids, lacking: 0 }; }
      links.forEach(function (l) { if (l.auto && !l.known && l.kind !== 'manual') { fresh.push(l); } });
      if (!fresh.length) { return { ids: ids, lacking: 0 }; }
      // A cut of the right place is not enough: it has to be a cut of the same CARD, by the rule the panel pairs cuts with cards by. A cut of
      // another transcript that happens to lie over the vanished one is no swap: the card has no cut now, and if it were kept as it is the
      // panel would have to make one (and the page's undo would be cut off). A cut that belonged to no card is judged by its place alone.
      function cardHasCut(k, id) {
        // the card the vanished cut belonged to: the one whose id it carries or it was tied to (no search), else the one its range fits
        var kc = (k.cid && S.candById[k.cid] && S.candById[k.cid].kind === k.kind) ? S.candById[k.cid] : ((k.card && S.candById[k.card] && S.candById[k.card].kind === k.kind) ? S.candById[k.card] : null);
        if (!kc) { kc = cardsOfLinks([{ id: id, kind: k.kind, start: k.start, end: k.end, cid: k.cid || '', card: k.card || '' }])[id]; }
        if (!kc) { return true; }
        if (!held) {
          var a = assignCuts(S.candidates, links, matchTol());
          held = {};
          S.candidates.forEach(function (c, i) { if (a.assigned[i]) { held[c.id] = true; } });
          a.extras.forEach(function (e) { held[S.candidates[e.card].id] = true; });
        }
        return !!held[kc.id];
      }
      gone.forEach(function (id) {
        var k = S.known[id];
        for (var i = 0; i < fresh.length; i++) {
          var l = fresh[i];
          if (l.kind === k.kind && ((k.cid && l.cid === k.cid) || (k.card && l.cid === k.card) || rangeMatch(l.start, l.end, k.start, k.end) >= 0)) {
            if (cardHasCut(k, id)) { ids[id] = true; n++; }
            return;
          }
        }
      });
      return { ids: ids, lacking: n ? gone.length - n : 0 };
    }
    /**
     * cuts that were in storage / known but have vanished from the page. live: the page took them away (the user deleted them, or
     * page undo did), so the panel remembers it:
     *   - an automatic cut, or an accepted cut whose card the engine would apply on its own anyway: a reject (restorable);
     *   - an accepted cut whose card needs a decision: the Accept is dropped, so the card is back under "Needs your decision".
     *     That is what page undo of an Accept means; a deleted cut looks the same to the panel, and the card is one click away;
     *   - an accepted cut whose card is not found by the cut's own id (the card moved, or its kind is switched off): its range is a reject.
     *   - a cut that took the place of a Reject (S.shadow, see adoptRestored) and is gone again: the Reject is the card's decision again.
     * keepAuto (refreshMarkers({ loaded: true }) after a session was loaded): a vanished automatic cut is no Reject, the session did not have it;
     * the card keeps its state and reconcileNow gives it its cut back. Accepted cuts that vanished are treated as above.
     */
    function syncExternal(live, keepAuto) {
      var cuts = getCutsSafe(), byId = {}, changed = false;
      cuts.forEach(function (c) { if (c) { byId[c.id] = c; } });
      var swapped = live && !keepAuto ? swappedOut(byId) : { ids: {}, lacking: 0 }, back = {};
      // A cut that took the place of a Reject (see adoptRestored) is gone again: the page went back over it, or forward to the moment of the
      // Reject, or the user took it out. The Reject is what the user last decided about that card, so it is the card's decision again.
      Object.keys(S.shadow).forEach(function (id) {
        var sh = S.shadow[id], c = byId[id], k = S.known[id];
        if (c && (!k || sameMarker(c, k))) { return; }
        delete S.shadow[id];
        if (live && !keepAuto && !swapped.ids[id]) {
          sh.forEach(function (r) { setDecision(S.decisions, r.kind, r.start, 'reject', r.end); });      // the Rejects as they were (a wide Reject over two cards comes back wide)
          back[id] = true; changed = true;
        }
      });
      Object.keys(S.known).forEach(function (id) {
        var k = S.known[id], c = byId[id];
        if (c && sameMarker(c, k)) { return; }
        if (live && k.kind !== 'manual' && !swapped.ids[id] && !back[id] && !(keepAuto && k.auto !== false)) {
          var kc = k.cid ? S.candById[k.cid] : null;
          if (kc && kc.kind !== k.kind) { kc = null; }
          if (kc && k.auto === false && kc.eff !== 'auto') {
            var kd = getDecision(S.decisions, kc.kind, kc.start, kc.end);
            if (kd && kd.d === 'accept') { removeDecision(S.decisions, kc.kind, kc.start, kc.end); }
          } else { rejectByPage(k.kind, kc ? kc.start : k.start, kc ? kc.end : k.end); }
        }
        delete S.known[id]; changed = true;
      });
      if (swapped.lacking) {
        var lack = swapped.lacking;
        toast('The cuts that came into the page leave out ' + lack + ' ' + plural(lack, 'cut', 'cuts') + ' that ' + plural(lack, 'was', 'were') + ' applied on ' + plural(lack, 'its', 'their') + ' own. ' + plural(lack, 'It is', 'They are') + ' listed under Rejected: press Restore to bring ' + plural(lack, 'it', 'them') + ' back.');
      }
      return changed;
    }

    /** the tolerance for "starts at the same place": 50 ms, or one and a half frames when that is more */
    function matchTol() { return Math.max(DECISION_TOL, fps() ? 1.5 / fps() : 0); }
    /**
     * The card each of the given cuts belongs to, by the rule reconcileNow pairs them by (assignCuts): { cut id: card }. A cut that fits
     * no card by that rule is not in it. The first card of a kind that starts within 0.1 s of a cut is NOT the cut's card (candForLink
     * says so, for the lists and for Z): to take a returned cut on for a card that reconcileNow then cannot pair with it would add a
     * second cut for that card, and in the page's history that is a new step that throws away its redo steps.
     */
    function cardsOfLinks(links) {
      var found = assignCuts(S.candidates, links, matchTol()), out = {};
      S.candidates.forEach(function (c, i) { if (found.assigned[i]) { out[found.assigned[i].id] = c; } });
      found.extras.forEach(function (e) { out[e.link.id] = S.candidates[e.card]; });
      return out;
    }
    /**
     * Z took a Reject back: the Accept it replaced is there again, with its cut. Page undo of that Z takes the cut away again, and what the page
     * had then was the Reject, so the Reject is kept aside for the cut (S.shadow), as it is when page undo brings an accepted cut back over a Reject.
     */
    function keepRejectsAside(flips) {
      var cardOf = cardsOfLinks(scanLinks()), byCard = {};
      scanLinks().forEach(function (l) { var c = cardOf[l.id]; if (c && !l.auto && l.kind !== 'manual') { byCard[c.id] = l; } });
      flips.forEach(function (ch) {
        var a = ch.after;
        for (var i = 0; i < S.candidates.length; i++) {
          var c = S.candidates[i], d = getDecision(S.decisions, c.kind, c.start, c.end);
          if (c.kind === a.kind && c.st === 'accepted' && d && d.d === 'accept' && byCard[c.id] && rangeMatch(a.start, a.end, c.start, c.end) >= 0) {
            S.shadow[byCard[c.id].id] = [{ kind: a.kind, start: a.start, end: a.end }];      // the Reject Z took back, as it was
            return;
          }
        }
      });
    }
    /**
     * A cut that the panel made, is not known to it any more and is back in the page, for example because the user pressed
     * undo or redo there. The user wants it, so the panel takes it on again; removing it a second time would make the page's
     * own undo do nothing (and every removal is a new history step that throws away the redo steps).
     *   - its card was rejected (the cut had vanished): the reject is dropped when the cut is an automatic one (the card is back
     *     as it was before the Reject: applied on its own, or waiting for a decision), and becomes an Accept when the cut is one
     *     the user accepted (so redo of an Accept gives the Accept back);
     *   - it is a cut the user accepted (origin.auto false), its card has no decision, and the panel did not know it: it
     *     becomes an Accept again. This is page redo, page undo of the panel's own Z, a loaded session with no saved decisions.
     * An automatic cut of a card that needs a decision is not adopted: it is not the user's, so the card still waits for a decision
     * (reconcileNow leaves the cut where it is).
     * A cut is adopted for the card reconcileNow pairs it with (cardsOfLinks), never for a card that only lies near it. The Reject that a
     * returned cut replaces is kept aside in S.shadow, keyed by the cut's id: see syncExternal, which gives it back when the cut is gone again.
     * inAnalysis: the analysis has just been run again (open, restore, a changed setting) and nothing the user did removed an
     * Accept, so even a cut the panel knows is kept when its card has no decision (the saved decisions were lost, or none matched).
     * keepAuto (refreshMarkers({ loaded: true })): the loaded call did not Reject the vanished automatic cut of a card that is applied on
     * its own here, so such a card is still 'auto' when the session carries a cut the user accepted for it: that cut becomes its Accept,
     * as it does after a plain call (where the Reject came first and the cut then brought the card back as an Accept).
     */
    function adoptRestored(inAnalysis, keepAuto) {
      var changed = false, links = scanLinks(), cardOf = cardsOfLinks(links);
      links.forEach(function (l) {
        if (l.kind === 'manual') { return; }
        var c = cardOf[l.id];          // the card reconcileNow pairs this cut with: a cut that fits no card by that rule speaks for none
        if (!c) { return; }
        var accepted = !l.auto && (l.by === 'cleanup-panel' || l.known);      // a cut the user accepted (not an automatic one)
        if (c.st === 'rejected' && !l.known) {
          // The cut takes the place of the Reject (page undo of the Reject, page redo of an Accept, a loaded session). The page cannot tell "undo of
          // that Accept" from "redo of the Reject", and the Reject is what the user last decided about this card: it is kept aside, and comes
          // back when this cut goes away again (syncExternal), unless the user does something in the panel meanwhile.
          // An automatic cut is never the user's Accept, whatever the card: the Reject is dropped and the card is as it was before it.
          // What is kept aside is the Reject as it was recorded (it may be wide, over two cards), and only a Reject of the user's: one the panel
          // wrote itself while it followed the page (rejectByPage) is no decision of the user's and is not given back.
          var rj = getDecision(S.decisions, c.kind, c.start, c.end), aside = [], rec;
          if (!c.failed && !accepted) {
            // A card that merged two cards (the minimum gap was raised) holds a Reject for each of them: every one goes, or the one left
            // would keep the card Rejected under a cut that is there
            while (rj && rj.d === 'reject') {
              rec = asideRecord(rj); if (rec) { aside.push(rec); }
              removeDecision(S.decisions, c.kind, c.start, c.end);
              rj = getDecision(S.decisions, c.kind, c.start, c.end);
            }
          } else { rec = asideRecord(rj); if (rec) { aside.push(rec); } setDecision(S.decisions, c.kind, c.start, 'accept', c.end); }
          if (aside.length && !inAnalysis) { S.shadow[l.id] = aside; }
        } else if (c.st === 'pending' && accepted && (!l.known || inAnalysis)) {
          setDecision(S.decisions, c.kind, c.start, 'accept', c.end);
        } else if (keepAuto && c.st === 'auto' && accepted && !l.known) {
          setDecision(S.decisions, c.kind, c.start, 'accept', c.end);
        } else { return; }
        changed = true;
      });
      return changed;
    }

    /* ---------------- candidates ---------------- */
    function pendingList() { return S.candidates.filter(function (c) { return c.st === 'pending'; }); }
    function candForLink(l) {
      if (l.cid && S.candById[l.cid]) { return S.candById[l.cid]; }
      var best = null, bd = 1;
      for (var i = 0; i < S.candidates.length; i++) {
        var c = S.candidates[i];
        if (c.kind !== l.kind) { continue; }
        var d = Math.abs(c.start - l.start);
        if (d <= 0.1 && d < bd) { best = c; bd = d; }
      }
      if (!best) {          // a cut whose card has moved (other settings, page undo of them): the overlap rule planReconcile uses
        var bs = 1e9;
        for (var j = 0; j < S.candidates.length; j++) {
          var c2 = S.candidates[j];
          if (c2.kind !== l.kind) { continue; }
          var sc = rangeMatch(l.start, l.end, c2.start, c2.end);
          if (sc >= 0 && sc < bs) { best = c2; bs = sc; }
        }
      }
      return best;
    }
    /**
     * Decisions saved by panel 1.0.0 have no end time, and the next engine moves some starts by 70-90 ms. Each such decision is
     * tied to a candidate of its kind whose start is within 0.15 s: it takes that candidate's range and from then on matches like
     * any other. A candidate that already has a decision of its own (made later, so newer) is not available, and an old decision
     * with only such candidates close by is dropped. The old decisions and the candidates are paired so that as many decisions as
     * possible get a candidate, the nearest pairs first: a decision never takes the candidate of one that is closer to it, so two
     * decisions and two cards that are 100 ms apart each keep their own card, whatever the order the decisions were made in.
     */
    function completeOldDecisions() {
      var old = S.decisions.filter(function (d) { return !(d.end > d.start); });
      if (!old.length) { return; }
      var edges = old.map(function (d) {                     // the candidates close to each old decision, nearest first
        var list = [];
        for (var j = 0; j < S.candidates.length; j++) {
          var c = S.candidates[j], dl = Math.abs(c.start - d.start);
          if (c.kind === d.kind && dl <= LEGACY_TOL + 1e-9) { list.push({ j: j, dl: dl }); }
        }
        return list.sort(function (x, y) { return x.dl - y.dl; });
      });
      var own = {}, owner = {};                              // own: candidate -> has a decision with an end time; owner: candidate -> old decision
      function hasOwn(j) {
        if (own[j] === undefined) {
          var c = S.candidates[j];
          own[j] = S.decisions.some(function (o) { return o.end > o.start && o.kind === c.kind && rangeMatch(o.start, o.end, c.start, c.end) >= 0; });
        }
        return own[j];
      }
      function place(i, seen) {                              // a free candidate (the nearest), else one whose decision can move to another
        var list = edges[i], k, e;
        for (k = 0; k < list.length; k++) { e = list[k]; if (!hasOwn(e.j) && owner[e.j] === undefined) { owner[e.j] = i; return true; } }
        for (k = 0; k < list.length; k++) {
          e = list[k];
          if (hasOwn(e.j) || seen[e.j]) { continue; }
          seen[e.j] = true;
          if (place(owner[e.j], seen)) { owner[e.j] = i; return true; }
        }
        return false;
      }
      var order = [], i;
      for (i = 0; i < old.length; i++) { if (edges[i].length) { order.push(i); } }
      order.sort(function (x, y) { return edges[x][0].dl - edges[y][0].dl || x - y; });
      order.forEach(function (idx) { place(idx, {}); });
      var got = {}, dropped = false, links = null, tied = {}, cardOf = null;
      function acceptedCuts() { if (!links) { links = scanLinks().filter(function (l) { return !l.auto && l.kind !== 'manual'; }); } return links; }      // in the order of their starts
      function cutsStartingNear(t) {      // the accepted cuts whose start is within the matching tolerance of t (binary search: there can be thousands of decisions and cuts)
        var all = acceptedCuts(), lo = 0, hi = all.length, tol = matchTol() + 1e-9, out = [], mid;
        while (lo < hi) { mid = (lo + hi) >> 1; if (all[mid].start < t - tol) { lo = mid + 1; } else { hi = mid; } }
        for (var i = lo; i < all.length && all[i].start <= t + tol; i++) { out.push(all[i]); }
        return out;
      }
      // The accepted cut panel 1.0.0 made for an Accept starts where the Accept does. Its candidate id is the old one, which the next engine
      // does not have, and the card has moved: a cut that fits its card by overlap alone is kept where it is (follow.own), and one that does
      // not even do that (a short stutter that moved by 90 ms) but still covers part of the card is tied to its card here, so that it is not
      // left next to a second cut for it. A cut that does not touch the card any more is the card's no longer: the card gets a cut of its own.
      function tieCutOf(d, card) {
        var best = null, bd = matchTol() + 1e-9;
        cutsStartingNear(d.start).forEach(function (l) {
          var dl = Math.abs(l.start - d.start);
          if (l.kind === d.kind && !tied[l.id] && dl <= bd && Math.min(l.end, card.end) - Math.max(l.start, card.start) > 0 && !(l.cid && S.candById[l.cid] && S.candById[l.cid].kind === l.kind)) { best = l; bd = dl; }
        });
        if (best) { tied[best.id] = true; S.ties[best.id] = card.id; }
      }
      Object.keys(owner).forEach(function (j) { got[owner[j]] = S.candidates[+j]; });
      old.forEach(function (d, idx) {
        if (!edges[idx].length) { return; }                  // far from every candidate: see below
        if (got[idx]) { if (d.d === 'accept') { tieCutOf(d, got[idx]); } d.start = got[idx].start; d.end = got[idx].end; } else { d.d = ''; dropped = true; }
      });
      // An Accept that is farther than that from the card it belongs to is still the Accept of the card that holds its cut (the one
      // reconcileNow pairs the cut with, by overlap): it takes that card's range, instead of staying behind as a stale decision next to the
      // one that is written for the card later.
      old.forEach(function (d, idx) {
        if (edges[idx].length || d.d !== 'accept') { return; }
        cutsStartingNear(d.start).forEach(function (l) {
          if (l.kind !== d.kind || d.end > d.start) { return; }
          if (!cardOf) { cardOf = cardsOfLinks(acceptedCuts()); }
          var c = cardOf[l.id], j = c ? S.candidates.indexOf(c) : -1;
          if (j >= 0 && c.kind === d.kind && !hasOwn(j) && owner[j] === undefined) { d.start = c.start; d.end = c.end; owner[j] = idx; }
        });
      });
      // What still has no end is farther than 0.15 s from every card of the current settings. The cards of the other levels may come back
      // (the level is the user's to change): while one of them is that close the decision stays. Otherwise the engine has no card for it
      // any more, nothing can ever match it, and it is dropped instead of staying behind for good.
      var left = S.decisions.filter(function (d) { return d.d !== '' && !(d.end > d.start); });
      if (left.length) {
        var every = everyCandidate(S.transcript);
        if (every.ran) {
          left.forEach(function (d) {
            var near = every.cands.some(function (c) { return c.kind === d.kind && Math.abs(c.start - d.start) <= LEGACY_TOL + 1e-9; });
            if (!near) { d.d = ''; dropped = true; }
          });
        }
      }
      if (dropped) { for (var k = S.decisions.length - 1; k >= 0; k--) { if (S.decisions[k].d === '') { S.decisions.splice(k, 1); } } }
    }
    function runAnalysis(live, keepAll, restoring) {
      S.shadow = {}; S.pageMade = new WeakSet();
      if (!S.transcript) { S.candidates = []; S.candById = {}; S.stats = null; return true; }
      var res;
      try { res = Engine.analyze(S.transcript, analysisParams()); }
      catch (e) { showError('The analysis could not run on this transcript: ' + (e && e.message ? e.message : e)); return false; }
      var list = (res && res.candidates) || [];
      S.stats = res && res.stats;
      S.analysisWarnings = res && Array.isArray(res.warnings) ? res.warnings.slice(0, 20) : [];
      S.candidates = classifyCandidates(list, S.decisions, S.settings.autoPct / 100, S.settings);
      S.candidates.sort(function (a, b) { return a.start - b.start; });
      S.candById = {};
      S.candidates.forEach(function (c) { S.candById[c.id] = c; });
      completeOldDecisions();                  // decisions saved by an older version have no end time: add it now
      reclassify();
      syncExternal(!!live);
      reclassify();
      // an accepted cut that is in the page without its Accept (lost storage, a loaded session, a reload) is kept, not removed
      if (adoptRestored(true)) { reclassify(); }
      reconcileNow(keepAll, live ? 'settings' : (restoring ? 'restore' : ''));
      persistDecisions(); persistKnown();
      return true;
    }

    /* ---------------- transcript load / clear ---------------- */
    function showError(msg) { S.error = msg || ''; renderNotes(); if (msg) { toast(msg); } }
    function panelCuts(includeManual) {
      return scanLinks().filter(function (l) { return includeManual || l.kind !== 'manual'; });
    }
    /**
     * The cuts the panel made for the transcript it holds. A loaded session's cuts that fit no card of it (S.strays), and accepted
     * cuts it never knew, were made for something else: they are not counted in a question about "the cuts made from it" and they are
     * not removed with it. A cut the panel only leaves alone (a stray) but that carries the id of a card of this very transcript, at any
     * level, is its own: page undo of a level change or a session saved under other settings brought it back onto a card that waits.
     */
    function ownCuts() {
      var ids = null;
      return panelCuts(false).filter(function (l) {
        if (!S.strays[l.id]) { return l.known; }
        if (!ids) { ids = heldIds(); }
        return !!l.cid && !!ids[l.kind + '|' + l.cid];
      });
    }
    /** 'kind|id' of every card the held transcript has at any level (with all the switches on) */
    function heldIds() {
      var ids = {}, key = S.transcript ? JSON.stringify(analysisParams()) : '';
      if (heldMemo && heldMemo.t === S.transcript && heldMemo.key === key) { return heldMemo.ids; }      // Remove asks twice (the question, then the removal)
      if (S.transcript) { everyCandidate(S.transcript).cands.forEach(function (c) { ids[c.kind + '|' + c.id] = true; }); }
      heldMemo = { t: S.transcript, key: key, ids: ids };
      return ids;
    }
    /** every candidate the engine finds in a transcript at every level with all the switches on, as { cands: [...], ran: false when the engine failed } */
    function everyCandidate(t) {
      var cands = [], ran = false, levels = levelsOn() ? LEVELS.map(function (lv) { return lv.id; }) : [null];
      levels.forEach(function (id) {
        var p = analysisParams(), res = null;
        if (id) { p.level = id; }
        p.includeDeadSpace = p.includeFillers = p.includeStutters = p.includeNonWords = true;
        try { res = Engine.analyze(t, p); } catch (e) { res = null; }      // runAnalysis reports a failure
        if (!res) { return; }
        ran = true;
        (res.candidates || []).forEach(function (c) {
          if (c && isFinite(c.start) && isFinite(c.end)) { cands.push({ id: c.id, kind: c.kind, start: c.start, end: c.end, st: 'auto' }); }
        });
      });
      return { cands: cands, ran: ran };
    }
    /**
     * How many of the panel's cuts on the timeline fit no card of this transcript (the same matching as planReconcile), and how many
     * cuts there are. For a transcript that is opened while the panel has none, to see whether the cuts belong to another transcript.
     * Cuts made under another level or with other switches must not look like another transcript's, so they are compared with what
     * every level finds with all the switches on. Pauses are left out: whether and where one is cut depends on the pause settings.
     * A cut of an um or er that fits no card still fits when it lines up with a word of the transcript: the list of filler words is
     * the user's own setting, so a session made with other words has cuts that no card of this computer's settings has.
     */
    function misfitCuts(t) {
      var mine = panelCuts(false).filter(function (l) { return l.kind !== 'dead-space'; });
      if (!mine.length) { return { total: 0, bad: 0 }; }
      var found = everyCandidate(t), cands = found.cands;
      if (!found.ran) { return { total: mine.length, bad: 0 }; }
      var plan = planReconcile(cands, mine, Math.max(DECISION_TOL, fps() ? 1.5 / fps() : 0), function () { return true; }, { moved: true });
      var words = Array.isArray(t && t.words) ? t.words : [], wi = null;
      function onAWord(l) {
        if (!wi) {          // the words with a start and an end, in the order of their starts (built once, when the first um is checked)
          wi = words.filter(function (w) { return w && isFinite(num(w.s, NaN)) && isFinite(num(w.e, NaN)); }).map(function (w) { return { s: num(w.s, 0), e: num(w.e, 0) }; });
          wi.sort(function (a, b) { return a.s - b.s; });
        }
        var lo = 0, hi = wi.length, mid;
        while (lo < hi) { mid = (lo + hi) >> 1; if (wi[mid].s < l.start - 0.06 - 1e-9) { lo = mid + 1; } else { hi = mid; } }
        for (var i = lo; i < wi.length && wi[i].s <= l.start + 0.06 + 1e-9; i++) {
          if (Math.abs(wi[i].s - l.start) <= 0.06 && Math.abs(wi[i].e - l.end) <= 0.06) { return true; }
        }
        return false;
      }
      var bad = plan.strays.concat(plan.orphans).filter(function (l) { return !(l.kind === 'filler' && onAWord(l)); });
      return { total: mine.length, bad: bad.length };
    }
    /**
     * The automatic cuts that opening the transcript t takes out beyond `mine` (the ones asked about): what reconcileNow would remove from the rest,
     * worked out the same way beforehand on the cards the open will have (no decisions yet: it is a different transcript). A cut the user accepted
     * is left out: opening takes it on as the Accept of its card (adoptRestored), and it stays.
     */
    function openRemovals(t, mine) {
      var res = null, gone = {};
      try { res = Engine.analyze(t, analysisParams()); } catch (e) { res = null; }
      if (!res || !Array.isArray(res.candidates)) { return []; }
      var cands = classifyCandidates(res.candidates, [], S.settings.autoPct / 100, S.settings);
      cands.sort(function (a, b) { return a.start - b.start; });
      mine.forEach(function (l) { gone[l.id] = true; });
      var rest = panelCuts(false).filter(function (l) { return !gone[l.id]; });
      return planReconcile(cands, rest, matchTol(), function (l) { return !l.known; }, followRules('')).remove.filter(function (l) { return l.auto; });
    }
    function loadParsed(parsed, opts) {
      var t = parsed.transcript;
      var tid = makeTid(t);
      var loadedSame = !!S.transcript && S.tid === tid;
      // the same file opened again after a reload (the transcript itself was not kept): its decisions are still in storage
      var saved = null;
      if (!loadedSame) {
        var dj = jget(KEYS.decisions);
        if (dj && typeof dj.tid === 'string' && (dj.tid === tid || dj.tid === hashString(JSON.stringify(t)))) { saved = dj; }
      }
      // the decisions record may be gone while the links record still carries the id of this very transcript
      var same = loadedSame || !!saved || (!!S.savedTid && (S.savedTid === tid || S.savedTid === hashString(JSON.stringify(t))));
      // The cuts on the timeline are "the old transcript's" only when there was one: loaded, or remembered by its links or decisions.
      // A saved transcript that waits for another video (S.dormant) never made a cut here. With no old transcript (a session was
      // loaded, or the browser lost its storage) the cuts stay, the ones that fit a card are taken on as they are (accepted cuts
      // stay accepted) and the others are left alone: nothing is asked and nothing is lost.
      var hadBefore = !!S.transcript || (!!S.savedTid && !S.dormant), misfit = 0;
      var mine = (!same && !opts.restore && hadBefore) ? ownCuts() : [];
      if (mine.length) {
        // A cut that carries the id of a card of the transcript being opened was made for that very card (a session of this transcript was
        // loaded while the panel held another one, and the cut happens to sit on a card of the old one): it stays and is taken on below.
        // An ACCEPTED cut stays only if the old transcript has no card with that id too (the leading pause, dead-space:0, is in nearly every
        // video): the id then tells nothing, and the user's Accept was for the old transcript. An automatic one stays: the new card uses it.
        var incoming = {}, held = null, stayed = 0;
        everyCandidate(t).cands.forEach(function (c) { incoming[c.kind + '|' + c.id] = true; });
        mine = mine.filter(function (l) {
          var k = l.kind + '|' + l.cid;
          if (!(l.cid && incoming[k])) { return true; }
          if (l.auto) { stayed++; return false; }
          if (!held) { held = heldIds(); }
          if (!held[k]) { stayed++; }
          return !!held[k];
        });
        // The cuts that stay are paired with the new cards when the transcript is opened, and a second cut that fits a card which has its own
        // already (two cuts carry one card's id) is taken out then. The question counts those too: it names what the open takes out.
        if (mine.length && stayed) { mine = mine.concat(openRemovals(t, mine)); }
        if (mine.length) {
          // a transcript made by the helper was already agreed to when the job started: no second question after the wait
          if (!opts.replaceOk && !ask('Opening a different transcript removes the ' + mine.length + ' ' + plural(mine.length, 'cut', 'cuts') + ' Audio cleanup made for the old one. Cuts you drew by hand stay. Continue?')) {
            return { ok: false, cancelled: true, error: 'Cancelled: the current transcript and its cuts were kept.' };
          }
          batch(function () { mine.forEach(removeCutSafe); });
        }
      } else if (!same && !opts.restore) {
        // no old transcript (or one the panel cannot tell its cuts from: only its decisions were left in storage), but cuts of the panel's
        // are on the timeline (a loaded session): they stay. When most of them were made for
        // some other transcript the two sets of cuts would be mixed, so say so first. Cancel changes nothing and does not open the file.
        var fit = misfitCuts(t);
        // a transcript the user asked the helper for took minutes to make: no question after the wait (Cancel would throw it away); it opens and says so
        if (fit.bad > 0 && fit.bad * 2 > fit.total && opts.source && opts.source.kind === 'helper') { misfit = fit.bad; }
        else if (fit.bad > 0 && fit.bad * 2 > fit.total &&
            !ask('This video already has ' + fit.bad + ' ' + plural(fit.bad, 'cut', 'cuts') + ' that ' + plural(fit.bad, 'does', 'do') + ' not fit this transcript. OK opens it and keeps ' + plural(fit.bad, 'that cut', 'those cuts') + '. Cancel leaves everything as it is.')) {
          return { ok: false, cancelled: true, error: 'Cancelled: the transcript was not opened and the cuts on the timeline were kept.' };
        }
      }
      S.transcript = t; S.format = parsed.format || ''; S.warnings = parsed.warnings || []; S.tid = tid; heldMemo = null;
      S.dormant = null; S.savedTid = ''; S.storageWarned = false;
      wordIdx = null; S.filter = 'all'; S.levelNoteOn = false; S.createOpen = false; S.setPin = null; S.enginesOpen = false;
      if (opts.source !== undefined) { S.source = cleanSource(opts.source); } else if (!loadedSame) { S.source = null; }
      // whatever the Create card still says (an error, the help steps, the old "Found N cuts" line) belongs to the old transcript.
      // jobDone() calls load() while its job is still 'running', so a finished job's own line is not lost here.
      if (S.job && (S.job.state === 'error' || S.job.state === 'cancelled' || S.job.state === 'help' || S.job.state === 'done')) { S.job = null; }
      if (!same && !opts.restore) { S.decisions = []; S.undo = []; }
      else if (saved && !loadedSame) { S.decisions = cleanDecisions(saved.list); S.undo = []; }
      S.forVideo = videoNow();
      S.error = '';
      S.selCard = ''; S.selA = S.selB = S.anchor = -1; S.query = ''; if (E.search) { E.search.value = ''; }
      if (!runAnalysis(false, !hadBefore)) { return { ok: false, error: S.error }; }
      if (!opts.restore) { persistTranscript(); }
      renderAll();
      var n = counts();
      return { ok: true, candidates: n.total, applied: n.applied, pending: n.pending, warnings: S.warnings.slice(), misfit: misfit };
    }
    function load(input, opts) {
      opts = opts || {};
      var text;
      try {
        text = typeof input === 'string' ? input : JSON.stringify(input);
        if (!text || !String(text).replace(/\s+/g, '')) { throw new Error('That file is empty.'); }
      } catch (e) { var m0 = e && e.message ? e.message : 'That transcript could not be read.'; showError(m0); return { ok: false, error: m0 }; }
      var parsed;
      try {
        parsed = Engine.parseTranscript(text);
        if (!parsed || !parsed.transcript) { throw new Error('That file does not look like a transcript.'); }
        if (typeof Engine.validateTranscript === 'function') {
          var v = Engine.validateTranscript(parsed.transcript);
          if (v && v.ok === false) { throw new Error('This transcript has problems: ' + (v.errors || []).slice(0, 3).join('; ')); }
        }
      } catch (e2) {
        var m = e2 && e2.message ? e2.message : 'That transcript could not be read.';
        showError(m);
        return { ok: false, error: m };
      }
      var r = loadParsed(parsed, opts);
      if (r.ok) {
        if (!opts.restore) {
          toast('Transcript opened: ' + r.candidates + ' ' + plural(r.candidates, 'cut', 'cuts') + ' found, ' + r.applied + ' applied on ' + plural(r.applied, 'its', 'their') + ' own.' +
            (r.misfit ? ' ' + r.misfit + ' ' + plural(r.misfit, 'cut', 'cuts') + ' already on the timeline ' + plural(r.misfit, 'does', 'do') + ' not fit it. ' + plural(r.misfit, 'It was', 'They were') + ' kept.' : ''));
          focusAfterLoad();
        }
      } else if (!r.cancelled) { showError(r.error); }
      return r;
    }
    function clearTranscript(opts) {
      opts = opts || {};
      if (opts.removeCuts) {
        var mine = ownCuts();
        batch(function () { mine.forEach(removeCutSafe); });
      }
      S.transcript = null; S.format = ''; S.warnings = []; S.tid = ''; S.candidates = []; S.candById = {}; S.stats = null; heldMemo = null;
      S.dormant = null; S.savedTid = ''; S.forVideo = null; S.storageWarned = false; S.strays = {}; S.shadow = {}; S.pageMade = new WeakSet();
      S.decisions = []; S.undo = []; S.error = ''; S.selCard = ''; S.selA = S.selB = S.anchor = -1; S.cur = -1;
      S.source = null; S.filter = 'all'; S.levelNoteOn = false; S.createOpen = false; S.setPin = null; S.enginesOpen = false; wordIdx = null;
      if (S.job && S.job.state === 'done') { S.job = null; }
      S.links = scanLinks(); rememberLinks(S.links);
      sset(KEYS.transcript, ''); sset(KEYS.decisions, ''); persistKnown();
      renderAll();
    }

    /** a saved transcript that belongs to another video waits here: nothing is cut until the user chooses */
    function dormantText(ref, now, why) {
      if (why === 'name') { return 'A saved transcript was made for \u201c' + clip(ref.name, 40) + '\u201d, not for this video (\u201c' + clip(now.name, 40) + '\u201d), so it was not applied.'; }
      return 'A saved transcript is ' + formatDuration(ref.duration) + ' long but this video is ' + formatDuration(now.duration) + ', so it was not applied.';
    }
    function useDormant() {
      var d = S.dormant;
      if (!d) { return; }
      var st = d.stored;
      S.dormant = null; S.savedTid = '';
      S.transcript = st.transcript; S.format = st.format || ''; S.warnings = Array.isArray(st.warnings) ? st.warnings : [];
      S.tid = makeTid(st.transcript);
      S.decisions = d.decisions || []; S.known = {}; S.strays = {}; S.undo = []; S.storageWarned = false;
      S.source = cleanSource(st.source); S.filter = 'all'; S.levelNoteOn = false; S.setPin = null; S.enginesOpen = false; wordIdx = null;
      S.forVideo = videoNow();
      S.selCard = ''; S.selA = S.selB = S.anchor = -1; S.query = ''; if (E.search) { E.search.value = ''; }
      if (!runAnalysis(false)) { renderAll(); return; }
      persistTranscript();
      renderAll();
      var n = counts();
      toast('Using the saved transcript for this video: ' + n.applied + ' ' + plural(n.applied, 'cut', 'cuts') + ' applied automatically.');
    }
    function forgetDormant() {
      S.dormant = null; S.savedTid = ''; S.known = {}; S.decisions = []; S.undo = [];
      sset(KEYS.transcript, ''); sset(KEYS.decisions, ''); sset(KEYS.links, '');
      S.links = scanLinks(); rememberLinks(S.links); persistKnown();
      renderAll();
      toast('The saved transcript was forgotten.');
    }
    function dismissError() { S.error = ''; renderHeader(); }

    function inPanel() { var a = doc.activeElement; return !!a && !!E.root && E.root.contains(a); }
    /** after the user opened a file with the panel's own button: put the keyboard on the first card, so A / R / Space work */
    function focusAfterLoad() {
      if (!inPanel()) { return; }                    // focus is somewhere else in the page: leave it alone
      if (!moveCard(0)) { try { E.root.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }

    /* ---------------- summary numbers ---------------- */
    function counts() {
      var n = { total: 0, applied: 0, pending: 0, accepted: 0, rejected: 0, manual: 0, saves: 0, pendingSeconds: 0, appliedSeconds: 0 };
      var pend = [], auto = [];
      S.candidates.forEach(function (c) {
        n.total++;
        if (c.st === 'auto') { n.applied++; auto.push(c); } else if (c.st === 'pending') { n.pending++; pend.push(c); }
        else if (c.st === 'accepted') { n.accepted++; } else if (c.st === 'rejected') { n.rejected++; }
      });
      S.links.forEach(function (l) { if (l.kind === 'manual') { n.manual++; } });
      n.saves = rangesLength(S.links);
      function secs(list) { return rangesLength(list.map(function (c) { return { start: c.start, end: c.end }; })); }
      n.pendingSeconds = secs(pend);
      n.appliedSeconds = secs(auto);
      return n;
    }

    /* ===========================================================================================
     * rendering: skeleton
     * ======================================================================================= */
    function buildSkeleton() {
      var root = h('div', { 'class': 'cp-root', tabindex: '-1', role: 'region', 'aria-label': 'Audio cleanup' });
      E.root = root;

      /* 1. header */
      E.fileInput = h('input', { type: 'file', accept: '.json,.srt,.vtt,.txt,application/json', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
      on(E.fileInput, 'change', function () {
        var f = E.fileInput.files && E.fileInput.files[0];
        if (f) { readFile(f); }
        try { E.fileInput.value = ''; } catch (e) { /* ignore */ }
      });
      E.openBtn = btn('Open transcript file\u2026', 'cp-btn-primary', openPicker, null, 'Choose the transcript file made by the helper script');
      E.makeBtn = btn('Make a new transcript', 'cp-btn-ghost cp-btn-sm', openCreateCard, null, 'Make a new transcript from the open video with the helper on this computer');
      E.removeBtn = btn('Remove', 'cp-btn-ghost cp-btn-sm', removeTranscript, 'trash', 'Forget this transcript');
      E.summary = h('p', { 'class': 'cp-summary', 'aria-live': 'polite' });
      E.summary2 = h('p', { 'class': 'cp-sub' });
      E.source = h('p', { 'class': 'cp-sub' });
      E.enginesText = h('p', { 'class': 'cp-sub cp-engines-t' });
      E.enginesBtn = h('button', { type: 'button', 'class': 'cp-link', 'aria-expanded': 'false', text: 'details' });
      on(E.enginesBtn, 'click', function () { S.enginesOpen = !S.enginesOpen; renderEngines(); });
      E.engines = h('div', { 'class': 'cp-engines', hidden: true }, [E.enginesText, E.enginesBtn]);
      E.notes = h('div', { 'class': 'cp-notes' });
      buildCreateCard();
      E.secHead = h('div', { 'class': 'cp-sec' }, [
        h('div', { 'class': 'cp-h' }, [h('h2', { 'class': 'cp-title', text: 'Audio cleanup' }), E.removeBtn, E.makeBtn, E.openBtn]),
        E.fileInput, E.create, E.summary, E.summary2, E.source, E.engines, E.notes
      ]);
      root.appendChild(E.secHead);

      /* 2. settings: the cleanup level first (always visible), the numeric settings under "Advanced" */
      E.setBody = buildSettingsBody();
      E.setToggle = h('button', { type: 'button', 'class': 'cp-disc cp-set-toggle', 'aria-expanded': 'false' });
      on(E.setToggle, 'click', function () { toggleUi('settings'); });
      E.secSet = h('div', { 'class': 'cp-sec' }, [E.setToggle, E.setBody]);
      root.appendChild(E.secSet);

      /* 3. queue: filter chips, bulk buttons under them, the tip, then the cards */
      E.qTitle = h('h3', { 'class': 'cp-title', text: 'Needs your decision' });
      E.queue = h('div', { 'class': 'cp-queue', tabindex: '-1', role: 'list', 'aria-label': 'Cuts that need your decision' });
      E.qEmpty = h('div', { 'class': 'cp-empty' });
      E.chips = h('div', { 'class': 'cp-chips', role: 'group', 'aria-label': 'Show only one kind of cut' });
      E.chipEls = {}; E.chipNums = {};
      CHIP_DEFS.forEach(function (def) {
        var b = h('button', { type: 'button', 'class': 'cp-chip', 'aria-pressed': 'false', title: 'Show only: ' + def.label.toLowerCase() });
        b.appendChild(h('span', { 'class': 'cp-chip-l', text: def.label }));
        b.appendChild(doc.createTextNode(' '));
        var cn = h('span', { 'class': 'cp-chip-n', text: '0' });
        b.appendChild(cn);
        on(b, 'click', function () { setFilter(def.id); });
        E.chipEls[def.id] = b; E.chipNums[def.id] = cn;
        E.chips.appendChild(b);
      });
      E.acceptAll = btn('Accept all 0', '', function () { bulkDecide(true); }, 'check', 'Cut every card in the list below');
      E.rejectAll = btn('Reject all 0', 'cp-btn-no', function () { bulkDecide(false); }, 'x', 'Keep every card in the list below');
      E.bulk = h('div', { 'class': 'cp-bulk cp-bulk-top' }, [E.acceptAll, E.rejectAll]);
      E.tip = h('p', { 'class': 'cp-tip', text: 'Tip: use the filters above to clear whole groups at once.' });
      E.keysCards = h('span');         // J K A R Space: only while there is a card to use them on
      E.keysUndo = h('span');          // Z: as long as there is something to take back
      [['J', 'next'], ['K', 'previous'], ['A', 'accept'], ['R', 'reject'], ['Space', 'preview'], ['Z', 'undo']].forEach(function (k, i) {
        var into = i < 5 ? E.keysCards : E.keysUndo;
        into.appendChild(h('kbd', { text: k[0] }));
        into.appendChild(doc.createTextNode(' ' + k[1] + (i < 5 ? ' \u00b7 ' : '')));
      });
      E.keys = h('p', { 'class': 'cp-keys' }, [E.keysCards, E.keysUndo]);
      E.secQueue = h('div', { 'class': 'cp-sec' }, [
        h('div', { 'class': 'cp-h' }, [E.qTitle]),
        E.chips, E.bulk, E.tip,
        E.queue, E.qEmpty,
        E.keys
      ]);
      root.appendChild(E.secQueue);

      /* 3b. cut a time range: straight under the queue, so anything the words do not show (a cough, a click) is easy to find */
      E.rangeToggle = h('button', { type: 'button', 'class': 'cp-disc', 'aria-expanded': 'false' });
      on(E.rangeToggle, 'click', function () { toggleUi('range'); });
      E.rangeBody = buildRangeBody();
      E.secRange = h('div', { 'class': 'cp-sec' }, [E.rangeToggle, E.rangeBody]);
      root.appendChild(E.secRange);

      /* 4. lists */
      E.lists = {};
      var listsWrap = h('div', { 'class': 'cp-sec' });
      [['applied', 'Applied automatically'], ['mine', 'Cuts you made'], ['rejected', 'Rejected']].forEach(function (d) {
        var name = d[0];
        var toggle = h('button', { type: 'button', 'class': 'cp-disc', 'aria-expanded': 'false' });
        on(toggle, 'click', function () { toggleUi(name); });
        var body = h('div', { 'class': 'cp-body', hidden: true });
        var tools = h('div', { 'class': 'cp-bulk' });
        var rows = h('div', { 'class': 'cp-rows' });
        if (name === 'applied') { E.undoAll = btn('Undo all automatic cuts', 'cp-btn-no', undoAllAuto, 'undo', 'Reject every automatic cut'); tools.appendChild(E.undoAll); }
        body.appendChild(tools); body.appendChild(rows);
        listsWrap.appendChild(toggle); listsWrap.appendChild(body);
        E.lists[name] = { toggle: toggle, body: body, rows: rows, label: d[1], limit: ROW_PAGE };
      });
      E.secLists = listsWrap;
      root.appendChild(listsWrap);

      /* 5. transcript */
      E.search = h('input', { type: 'search', 'class': 'cp-in', placeholder: 'Search the transcript', 'aria-label': 'Search the transcript', autocomplete: 'off', spellcheck: 'false' });
      on(E.search, 'input', function () { later('search', 150, function () { runSearch(false); }); });
      on(E.search, 'keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          if (E.search.value !== S.query) {
            // typed and pressed Enter before the search caught up: search now and go to the first match (the last for Shift)
            if (timers.search) { clearTimeout(timers.search); timers.search = null; }
            runSearch(false);
            if (S.hits.length) { showHit(e.shiftKey ? S.hits.length - 1 : 0, true); }
          } else if (S.hits.length) { gotoHit(e.shiftKey ? -1 : 1); } else { runSearch(false); }
        }
        else if (e.key === 'Escape') {
          // one Esc clears the box and leaves it, so J K A R work again; the page's own Esc (which would leave the box) never gets here
          e.stopPropagation();
          if (E.search.value) { E.search.value = ''; runSearch(false); }
          try { E.root.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
        }
      });
      E.hitCount = h('span', { 'class': 'cp-hitcount', 'aria-live': 'polite' });
      E.prevHit = btn('Prev', 'cp-btn-sm', function () { gotoHit(-1); }, null, 'Previous match');
      E.nextHit = btn('Next', 'cp-btn-sm', function () { gotoHit(1); }, null, 'Next match');
      E.follow = h('input', { type: 'checkbox' });
      on(E.follow, 'change', function () { S.ui.follow = !!E.follow.checked; persistUi(); });
      E.tscroll = h('div', { 'class': 'cp-tscroll', tabindex: '0', role: 'region', 'aria-label': 'Transcript' });
      E.tinner = h('div', { 'class': 'cp-tinner' });
      E.tscroll.appendChild(E.tinner);
      E.floatInfo = h('span', { 'class': 'cp-sub' });
      E.cutBtn = btn('Cut selection', 'cp-btn-primary', cutSelection, 'scissors', 'Cut the selected words (X)');
      E.uncutBtn = btn('Uncut', '', uncutSelection, 'undo', 'Remove the cut that covers the selected words');
      E.selPrev = btn('Preview', '', previewSelection, 'play', 'Play the selected words');
      E.selClear = btn('Clear', 'cp-btn-ghost', function () { clearSelection(); }, 'x', 'Clear the selection (Esc)');
      E.float = h('div', { 'class': 'cp-float', hidden: true }, [E.floatInfo, E.cutBtn, E.uncutBtn, E.selPrev, E.selClear]);
      E.txWrap = h('div', { 'class': 'cp-tx' }, [E.tscroll, E.float]);
      E.secTx = h('div', { 'class': 'cp-sec' }, [
        h('div', { 'class': 'cp-h' }, [
          h('h3', { 'class': 'cp-title', text: 'Transcript' }),
          h('label', { 'class': 'cp-check' }, [E.follow, h('span', { text: 'Follow playback' })])
        ]),
        h('div', { 'class': 'cp-search' }, [icon('search'), E.search, E.prevHit, E.nextHit, E.hitCount]),
        E.txWrap,
        h('p', { 'class': 'cp-hint', text: 'Click a word to jump there. Drag, or Shift-click, to select words, then press X to cut them. Dotted words need a decision; struck-through words are cut.' })
      ]);
      root.appendChild(E.secTx);

      wireTranscriptEvents();
      wireRootEvents(root);
      return root;
    }

    /** "How much should I do on my own?": one compact segmented control (real radio buttons) and the help line of the chosen level */
    function buildLevelGroup() {
      var fs = h('fieldset', { 'class': 'cp-level' });
      fs.appendChild(h('legend', { text: 'How much should I do on my own?' }));
      E.levelRadios = {}; E.levelLabels = {};
      var helpId = 'cp-level-help-' + uid;
      var seg = h('div', { 'class': 'cp-seg' });
      LEVELS.forEach(function (lv) {
        var rid = 'cp-level-' + uid + '-' + lv.id;
        var input = h('input', { type: 'radio', name: 'cp-level-' + uid, id: rid, 'aria-describedby': helpId });
        var lab = h('label', { 'class': 'cp-seg-opt', 'for': rid }, [input, h('span', { text: lv.label })]);
        on(input, 'change', function () { if (input.checked) { chooseLevel(lv.id); } });
        E.levelRadios[lv.id] = input; E.levelLabels[lv.id] = lab;
        seg.appendChild(lab);
      });
      fs.appendChild(seg);
      E.levelHelp = h('p', { 'class': 'cp-seg-help', id: helpId });
      fs.appendChild(E.levelHelp);
      E.levelNote = h('p', { 'class': 'cp-level-note', role: 'status', 'aria-live': 'polite' });
      fs.appendChild(E.levelNote);
      fs.hidden = !levelsOn();
      return fs;
    }

    function buildSettingsBody() {
      var body = h('div', { 'class': 'cp-body cp-set', hidden: true });
      E.levelBox = buildLevelGroup();
      body.appendChild(E.levelBox);
      E.advToggle = h('button', { type: 'button', 'class': 'cp-disc', 'aria-expanded': 'false' });
      on(E.advToggle, 'click', function () { toggleUi('advanced'); });
      E.advBody = h('div', { 'class': 'cp-body cp-set', hidden: true });
      body.appendChild(h('div', { 'class': 'cp-adv' }, [E.advToggle, E.advBody]));
      buildAdvancedFields(E.advBody);
      return body;
    }

    function buildAdvancedFields(body) {
      function numField(key, before, after, min, max, step) {
        var input = h('input', { type: 'number', 'class': 'cp-in', min: min, max: max, step: step, inputmode: 'decimal', id: 'cp-set-' + key });
        var label = h('label', { 'for': 'cp-set-' + key }, [before + ' ']);
        var wrap = h('div', { 'class': 'cp-field' }, [label, input, after ? h('span', { text: after }) : null]);
        on(input, 'input', function () { later('settings', 450, function () { applySettingsFromInputs(false); }); });
        on(input, 'change', function () { applySettingsFromInputs(true); });
        E['set_' + key] = input;
        return wrap;
      }
      function checkField(key, label) {
        var input = h('input', { type: 'checkbox' });
        on(input, 'change', function () { applySettingsFromInputs(true); });
        E['set_' + key] = input;
        return h('label', { 'class': 'cp-check' }, [input, h('span', { text: label })]);
      }
      body.appendChild(numField('minGap', 'Silence longer than', 's counts as dead space', '0.2', '30', '0.1'));
      body.appendChild(numField('keepPause', 'Leave a pause of', 's', '0', '3', '0.05'));
      body.appendChild(numField('autoPct', 'Apply automatically when confidence is at least', '%', '50', '100', '1'));
      body.appendChild(checkField('deadSpace', 'Dead space (long silences)'));
      body.appendChild(checkField('ums', 'Ums and ers'));
      body.appendChild(checkField('stutters', 'Stutters and repeated words'));
      body.appendChild(checkField('nonWords', 'Other sounds (breaths, clicks, mouth noises)'));
      E.set_fillerWords = h('input', { type: 'text', 'class': 'cp-in cp-wide', id: 'cp-set-fillers', autocomplete: 'off', spellcheck: 'false' });
      on(E.set_fillerWords, 'change', function () { applySettingsFromInputs(true); });
      on(E.set_fillerWords, 'input', function () { later('settings', 700, function () { applySettingsFromInputs(false); }); });
      body.appendChild(h('div', { 'class': 'cp-field' }, [
        h('label', { 'for': 'cp-set-fillers', text: 'Words to treat as ums (separate with commas)' }),
        E.set_fillerWords
      ]));
      body.appendChild(h('div', { 'class': 'cp-bulk' }, [
        btn('Reset words', 'cp-btn-sm', function () { E.set_fillerWords.value = DEFAULT_FILLERS.join(', '); applySettingsFromInputs(true); }, null, 'Put the standard list back'),
        btn('Reset all settings', 'cp-btn-sm', function () { S.settings = normalizeSettings({}); syncSettingsInputs(null); settingsChanged(); }, null, 'Back to the standard settings' + (levelsOn() ? ', including the cleanup level' : ''))
      ]));
      body.appendChild(h('p', { 'class': 'cp-sub', text: 'Changing a setting runs the analysis again. Your Accept and Reject choices are kept.' }));
      return body;
    }

    function buildRangeBody() {
      var body = h('div', { 'class': 'cp-body cp-form', hidden: true });
      E.rStart = h('input', { type: 'text', 'class': 'cp-in', placeholder: '1:23.45', 'aria-label': 'Start time', autocomplete: 'off', spellcheck: 'false' });
      E.rEnd = h('input', { type: 'text', 'class': 'cp-in', placeholder: '1:25.00', 'aria-label': 'End time', autocomplete: 'off', spellcheck: 'false' });
      E.rMsg = h('p', { 'class': 'cp-form-msg', role: 'status', 'aria-live': 'polite' });
      body.appendChild(h('p', { 'class': 'cp-sub', text: 'Cut anything that is not words, such as a cough or keyboard noise. Type times like 1:23.45 or 83.45.' }));
      body.appendChild(h('div', { 'class': 'cp-field' }, [h('span', { text: 'Start' }), E.rStart, btn('Use current time', 'cp-btn-sm', function () { E.rStart.value = formatTime(safe(function () { return num(api.getTime(), 0); }, 0)); }, null, 'Fill in the playhead time')]));
      body.appendChild(h('div', { 'class': 'cp-field' }, [h('span', { text: 'End' }), E.rEnd, btn('Use current time', 'cp-btn-sm', function () { E.rEnd.value = formatTime(safe(function () { return num(api.getTime(), 0); }, 0)); }, null, 'Fill in the playhead time')]));
      body.appendChild(E.rMsg);
      body.appendChild(h('div', { 'class': 'cp-bulk' }, [
        btn('Cut this range', 'cp-btn-primary', cutTypedRange, 'scissors'),
        btn('Preview', '', previewTypedRange, 'play')
      ]));
      return body;
    }

    /* ===========================================================================================
     * rendering: sections
     * ======================================================================================= */
    /** Settings is open while no transcript is loaded (that is when the level question is the next thing to do), and one line after that */
    function settingsOpen() { return S.setPin === null ? !S.transcript : !!S.setPin; }
    function toggleUi(name) {
      if (name === 'settings') { S.setPin = !settingsOpen(); renderDisclosures(); return; }
      S.ui[name] = !S.ui[name]; persistUi(); renderDisclosures();
      if (name !== 'range' && name !== 'advanced') { renderLists(); }
    }

    function renderDisclosures() {
      function setDisc(toggle, body, label, open, count) {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        clearEl(toggle);
        toggle.appendChild(icon(open ? 'chevron-down' : 'chevron-right'));
        toggle.appendChild(h('span', { text: label }));
        if (count !== undefined && count !== null) { toggle.appendChild(h('span', { 'class': 'cp-cnt', text: '(' + count + ')' })); }
        body.hidden = !open;
      }
      var lv = levelsOn() ? levelById(S.settings.level) : null, so = settingsOpen();
      // closed, the one line still names the level: "Cleanup level: Balanced - change"
      setDisc(E.setToggle, E.setBody, so ? 'Settings' : (lv ? 'Cleanup level: ' + lv.label + ' - change' : 'Settings - change'), so);
      setDisc(E.advToggle, E.advBody, 'Advanced', !!S.ui.advanced);
      setDisc(E.rangeToggle, E.rangeBody, 'Cut a time range', !!S.ui.range);
      var n = listCounts();
      ['applied', 'mine', 'rejected'].forEach(function (k) { setDisc(E.lists[k].toggle, E.lists[k].body, E.lists[k].label, !!S.ui[k], n[k]); });
    }

    function listCounts() {
      var applied = 0, mine = 0;
      S.links.forEach(function (l) { if (l.auto) { applied++; } else { mine++; } });
      var rejected = 0;
      S.candidates.forEach(function (c) { if (c.st === 'rejected') { rejected++; } });
      return { applied: applied, mine: mine, rejected: rejected };
    }

    /** write the settings into the boxes. A box named in skip (the one being typed in) is never touched. */
    function syncSettingsInputs(skip) {
      var s = S.settings;
      function put(el, v) { if (el !== skip) { el.value = v; } }
      put(E.set_minGap, String(s.minGap)); put(E.set_keepPause, String(s.keepPause)); put(E.set_autoPct, String(s.autoPct));
      E.set_deadSpace.checked = !!s.deadSpace; E.set_ums.checked = !!s.ums; E.set_stutters.checked = !!s.stutters; E.set_nonWords.checked = !!s.nonWords;
      put(E.set_fillerWords, fillerText());
      E.follow.checked = !!S.ui.follow;
      LEVELS.forEach(function (lv) {
        var on_ = lv.id === s.level;
        E.levelRadios[lv.id].checked = on_;
        E.levelLabels[lv.id].className = 'cp-seg-opt' + (on_ ? ' cp-on' : '');
      });
      var cur = levelsOn() ? levelById(s.level) : null;
      if (E.levelHelp) { setText(E.levelHelp, cur ? cur.help : ''); }          // the help of the chosen level only
    }
    /**
     * Read the boxes and re-run the analysis when a setting changed. commit: the user finished (Enter, left the box, clicked
     * a switch or button): junk and out-of-range values are fixed and the boxes show the final values. Otherwise (a pause in
     * typing) a number that is empty or outside its limits is ignored for now, and the box being typed in is never rewritten.
     */
    function applySettingsFromInputs(commit) {
      if (destroyed) { return; }
      if (timers.settings) { clearTimeout(timers.settings); timers.settings = null; }
      var typing = commit === true ? null : doc.activeElement;
      function numValue(key) {
        var input = E['set_' + key], raw = String(input.value == null ? '' : input.value);
        if (commit === true) { return raw; }
        var n = parseFloat(raw);
        return raw.replace(/\s+/g, '') !== '' && isFinite(n) && n >= NUM_LIMITS[key][0] && n <= NUM_LIMITS[key][1] ? raw : S.settings[key];
      }
      var list = parseFillerList(String(E.set_fillerWords.value || ''));
      var isDefault = list.join(',') === DEFAULT_FILLERS.map(normPhrase).join(',') || !list.length;
      // typing a confidence limit of one's own stops it from following the level
      // (a box left empty or filled with junk goes back to following the level)
      var pctRaw = numValue('autoPct'), pctNum = typeof pctRaw === 'number' ? pctRaw : parseFloat(pctRaw);
      var pctOk = isFinite(pctNum) && String(pctRaw).replace(/s+/g, '') !== '';
      var pctNow = pctOk ? Math.round(clamp(pctNum, NUM_LIMITS.autoPct[0], NUM_LIMITS.autoPct[1])) : levelAutoPct(S.settings.level);
      var next = normalizeSettings({
        minGap: numValue('minGap'), keepPause: numValue('keepPause'), autoPct: pctNow, autoPctSet: pctOk && (S.settings.autoPctSet || pctNow !== S.settings.autoPct),
        level: S.settings.level,
        deadSpace: E.set_deadSpace.checked, ums: E.set_ums.checked, stutters: E.set_stutters.checked, nonWords: E.set_nonWords.checked,
        fillerWords: isDefault ? '' : list.join(', ')
      });
      if (JSON.stringify(next) === JSON.stringify(S.settings)) { if (commit === true) { syncSettingsInputs(null); } return; }
      S.settings = next;
      syncSettingsInputs(typing);
      settingsChanged();
    }
    function settingsChanged(fromLevel) {
      persistSettings();
      if (!fromLevel) { S.levelNoteOn = false; }
      if (S.error) { S.error = ''; if (!S.transcript) { renderHeader(); } }
      renderDisclosures();
      if (!S.transcript) { renderLevelNote(); return; }
      runAnalysis(true);
      S.undo = [];
      renderAll(true);                       // the queue filter stays; it falls back to "All" itself when its group is empty
    }
    /** the user chose a cleanup level: run the analysis again (decisions are kept) and say what it did */
    function chooseLevel(id) {
      if (destroyed || !levelById(id)) { return; }
      if (id === S.settings.level) { syncSettingsInputs(null); return; }
      S.settings = normalizeSettings({
        minGap: S.settings.minGap, keepPause: S.settings.keepPause, autoPct: S.settings.autoPct, autoPctSet: S.settings.autoPctSet, level: id,
        deadSpace: S.settings.deadSpace, ums: S.settings.ums, stutters: S.settings.stutters, nonWords: S.settings.nonWords, fillerWords: S.settings.fillerWords
      });
      S.levelNoteOn = !!S.transcript;
      syncSettingsInputs(null);
      settingsChanged(true);
      renderLevelNote();
    }
    function renderLevelNote() {
      if (!E.levelNote) { return; }
      var lv = levelsOn() ? levelById(S.settings.level) : null;
      if (!S.levelNoteOn || !S.transcript || !lv) { E.levelNote.textContent = ''; return; }
      var n = counts();
      E.levelNote.textContent = levelNoteText(lv.label, n.applied, n.pending);
    }

    function renderNotes() {
      if (!E.notes) { return; }
      clearEl(E.notes);
      function note(text, cls, buttons) {
        var act = !!(buttons && buttons.length);
        E.notes.appendChild(h(act ? 'div' : 'p', { 'class': 'cp-note' + (cls ? ' ' + cls : '') + (act ? ' cp-act' : ''), role: cls === 'cp-err' ? 'alert' : null, text: act ? null : text },
          act ? [h('span', { 'class': 'cp-ntext', text: text }), h('span', { 'class': 'cp-nbtns' }, buttons)] : null));
      }
      if (S.error) { note(S.error, 'cp-err', [btn('Dismiss', 'cp-btn-sm cp-btn-ghost', dismissError, null, 'Hide this message')]); }
      if (S.dormant) {
        note(S.dormant.text, 'cp-warn', [
          btn('Use it anyway', 'cp-btn-sm', useDormant, null, 'Apply the saved transcript to this video'),
          btn('Forget it', 'cp-btn-sm cp-btn-ghost', forgetDormant, null, 'Delete the saved transcript')
        ]);
      }
      if (S.transcript) {
        var seen = {}, all = [];
        (S.warnings || []).concat(S.analysisWarnings || []).forEach(function (w) { w = String(w); if (!seen[w]) { seen[w] = true; all.push(w); } });
        all.slice(0, 4).forEach(function (w) { note(w, 'cp-warn'); });
        if (all.length > 4) { note('And ' + (all.length - 4) + ' more notices about this file.'); }
        var vd = duration(), td = S.transcript.video && num(S.transcript.video.duration, 0);
        var vn = videoName(), tn = S.transcript.video && S.transcript.video.name ? String(S.transcript.video.name) : '';
        if (vd > 0 && td > 0 && Math.abs(vd - td) > Math.max(2, vd * 0.02)) {
          note('This transcript is ' + formatDuration(td) + ' long but the video is ' + formatDuration(vd) + '. Check that it belongs to this video.', 'cp-warn');
        } else if (vn && tn && baseName(vn) !== baseName(tn)) {
          note('This transcript was made for \u201c' + clip(tn, 40) + '\u201d but the open video is \u201c' + clip(vn, 40) + '\u201d. Check that it belongs to this video.', 'cp-warn');
        }
        var hasAudio = S.transcript.hasAudio !== undefined ? !!S.transcript.hasAudio : !!((S.transcript.silences && S.transcript.silences.length) || (S.transcript.sounds && S.transcript.sounds.length));
        if (!hasAudio && !all.some(function (w) { return /audio (information|analysis)/i.test(w); })) { note('This file has no audio analysis, so silences are judged from the gaps between words only.'); }
        if (S.storageWarned) {
          note(S.decisionsUnsaved ? 'This transcript is too big to remember between sessions, and your decisions could not be saved either. Open the file again next time.'
            : 'This transcript is too big to remember between sessions. Open the file again next time; your decisions are still saved.');
        }
      }
    }

    /** the Engines line is one line (cut with an ellipsis); "details" shows all of it. A short line needs no button. */
    function renderEngines() {
      if (!E.engines) { return; }
      var txt = S.engineText || '', long_ = txt.length > ENGINES_ONE_LINE, open = long_ && !!S.enginesOpen;
      setText(E.enginesText, txt);
      if (long_) { E.enginesText.setAttribute('title', txt); } else { E.enginesText.removeAttribute('title'); }
      E.engines.className = 'cp-engines' + (open ? ' cp-open' : '');
      setHidden(E.enginesBtn, !long_);
      setText(E.enginesBtn, open ? 'hide details' : 'details');
      E.enginesBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function renderHeader() {
      var has = !!S.transcript;
      setHidden(E.summary, !has); setHidden(E.engines, !has); setHidden(E.removeBtn, !has);
      var src = has ? S.source : null;
      E.source.textContent = src ? (src.kind === 'helper' ? 'Made by the helper on this computer' : 'From the file \u201c' + clip(src.name, 50) + '\u201d') : '';
      setHidden(E.source, !src);
      if (has) {
        var n = counts();
        E.summary.textContent = summaryText({
          total: n.total, applied: n.applied, pending: n.pending, saves: n.saves, appliedSeconds: n.appliedSeconds, pendingSeconds: n.pendingSeconds
        });
        var bits = [];
        if (n.saves >= 0.5) { bits.push('Saves ' + formatDuration(n.saves) + ' so far'); }
        if (n.accepted) { bits.push(n.accepted + ' accepted'); }
        if (n.rejected) { bits.push(n.rejected + ' rejected'); }
        if (n.manual) { bits.push(n.manual + ' cut by hand'); }
        E.summary2.textContent = bits.join(' \u00b7 ');
        setHidden(E.summary2, !bits.length);
        var eng = S.transcript.engines || {}, parts = [];
        if (eng.parakeet) { parts.push('Parakeet: ' + eng.parakeet); }
        if (eng.whisper) { parts.push('Whisper: ' + eng.whisper); }
        if (eng.audio) { parts.push('Audio: ' + eng.audio); }
        if (!parts.length && S.format) { parts.push('Format: ' + S.format); }
        S.engineText = parts.length ? 'Engines \u2013 ' + parts.join(' \u00b7 ') : '';
        setHidden(E.engines, !parts.length);
      } else {
        E.summary.textContent = ''; E.summary2.textContent = ''; S.engineText = '';
        setHidden(E.summary2, true);
      }
      renderEngines();
      renderNotes();
      renderCreate();
      renderLevelNote();
    }

    /* ---------------- queue ---------------- */
    function renderQueue(rebuild) {
      var has = !!S.transcript;
      setHidden(E.secQueue, !has);
      if (!has) { cardEls.clear(); clearEl(E.queue); return; }
      if (rebuild) { cardEls.clear(); clearEl(E.queue); }
      syncQueue();
    }
    /** the cards the queue shows: the undecided ones that the current filter lets through, in time order */
    function visibleList() {
      var all = pendingList();
      return S.filter === 'all' ? all : all.filter(function (c) { return chipIdOf(c.kind) === S.filter; });
    }
    function setFilter(id) {
      if (!E.chipEls[id] || id === S.filter) { return; }
      S.filter = id;
      syncQueue(true);
    }
    /** chips: only those with cards, each with its count; the pressed one is the filter. Updated in place so a focused chip keeps focus. */
    function renderChips(cc) {
      CHIP_DEFS.forEach(function (d) {
        var b = E.chipEls[d.id], n = cc[d.id] || 0;
        b.hidden = n === 0 && d.id !== 'all';
        setText(E.chipNums[d.id], String(n));
        b.setAttribute('aria-pressed', S.filter === d.id ? 'true' : 'false');
        b.setAttribute('title', 'Show only: ' + d.label.toLowerCase() + ' (' + n + ')');
      });
    }
    /** quiet: the user clicked a chip, so leave the transcript where it is */
    function syncQueue(quiet) {
      var pend = pendingList(), cc = chipCounts(pend);
      if (S.filter !== 'all' && !cc[S.filter]) { S.filter = 'all'; }      // the group is used up: show everything again
      var want = S.filter === 'all' ? pend : pend.filter(function (c) { return chipIdOf(c.kind) === S.filter; });
      var wantIds = {};
      want.forEach(function (c) { wantIds[c.id] = c; });
      renderChips(cc);
      setHidden(E.chips, pend.length === 0);
      setHidden(E.bulk, pend.length === 0);
      setHidden(E.tip, pend.length <= TIP_MIN);
      setBtnLabel(E.acceptAll, 'Accept all ' + want.length);
      setBtnLabel(E.rejectAll, 'Reject all ' + want.length);
      var hadFocus = !!doc.activeElement && doc.activeElement !== E.root && E.root.contains(doc.activeElement);
      var oldSel = S.selCard;
      cardEls.forEach(function (el, id) {
        if (!wantIds[id]) { if (el.parentNode) { el.parentNode.removeChild(el); } cardEls.delete(id); }
      });
      var prev = null;
      want.forEach(function (c) {
        var el = cardEls.get(c.id);
        if (!el) { el = makeCard(c); cardEls.set(c.id, el); }
        var expected = prev ? prev.nextSibling : E.queue.firstChild;
        if (el !== expected) { E.queue.insertBefore(el, expected); }
        prev = el;
      });
      var n = want.length;
      E.qTitle.textContent = 'Needs your decision (' + pend.length + ')';
      setHidden(E.qEmpty, n > 0);
      setHidden(E.queue, n === 0);
      E.acceptAll.disabled = n === 0; E.rejectAll.disabled = n === 0;
      applyKeysHint(n);
      E.qEmpty.textContent = S.candidates.length ? 'Nothing needs your decision. Every cut is either applied or rejected.' : 'No cuts found, so there is nothing to decide.';
      var picked = S.selCard;
      if (!wantIds[picked]) {
        var pick = null;
        for (var i = 0; i < want.length; i++) { if (want[i].start >= S.selStart) { pick = want[i]; break; } }
        if (!pick && want.length) { pick = want[want.length - 1]; }
        picked = pick ? pick.id : '';
      }
      selectCard(picked, { reveal: picked !== oldSel, transcript: !quiet && hadFocus && picked !== oldSel });
      // the thing that had the keyboard is gone, hidden or disabled (a removed card, the "Accept all" button after the last card):
      // give it to the next card, or to the panel itself, so the keys (Z to undo the last decision) keep working
      if (hadFocus && focusStranded()) { restoreFocus(); }
      if (oldSel !== S.selCard) { repaintCand(oldSel); repaintCand(S.selCard); }
    }

    /** the keyboard has nowhere to go: its element was removed, hidden or disabled, or focus fell to the page body */
    function focusStranded() {
      var a = doc.activeElement;
      if (!a || a === doc.body || !E.root.contains(a)) { return true; }
      if (a.disabled) { return true; }
      for (var n = a; n && n !== E.root; n = n.parentNode) { if (n.hidden) { return true; } }
      return false;
    }
    function restoreFocus() {
      var sel = S.selCard ? cardEls.get(S.selCard) : null;
      try { (sel || E.root).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      if (sel) { revealInPanel(sel); }
    }
    /** J K A R Space need a card; Z needs something to take back. Shown while either is true. */
    function applyKeysHint(nCards) {
      if (!E.keys) { return; }
      setHidden(E.keys, nCards === 0 && !S.undo.length);
      setHidden(E.keysCards, nCards === 0);
    }
    function syncKeysHint() { applyKeysHint(visibleList().length); }

    function makeCard(c) {
      var info = kindInfo(c.kind), pct = Math.round(c.confidence * 100), ctx = buildContext(S.transcript, c, 5, 5, 8);
      var card = h('div', {
        'class': 'cp-card ' + kindClass(c.kind), tabindex: '-1', role: 'listitem', 'data-id': c.id,
        'aria-label': info.label + ' at ' + formatTime(c.start) + ', ' + pct + '% sure'
      });
      var timeBtn = h('button', { type: 'button', 'class': 'cp-time', title: 'Jump to this moment', text: formatTime(c.start) + ' \u2013 ' + formatTime(c.end) });
      on(timeBtn, 'click', function () { seekTo(c.start); });
      card.appendChild(h('div', { 'class': 'cp-card-top' }, [
        h('span', { 'class': 'cp-badge', text: info.label, title: info.help }), timeBtn, h('span', { 'class': 'cp-len', text: formatLen(c.end - c.start) })
      ]));
      var ctxEl = h('div', { 'class': 'cp-ctx' });
      ctxEl.appendChild(doc.createTextNode((ctx.lead ? '\u2026 ' : '') + (ctx.before ? ctx.before + ' ' : '')));
      ctxEl.appendChild(h('mark', { text: ctx.hit }));
      ctxEl.appendChild(doc.createTextNode((ctx.after ? ' ' + ctx.after : '') + (ctx.trail ? ' \u2026' : '')));
      card.appendChild(ctxEl);
      var fill = h('div', { 'class': 'cp-fill' + (pct < 60 ? ' cp-low' : (pct < 85 ? ' cp-mid' : '')) });
      fill.style.width = pct + '%';
      card.appendChild(h('div', { 'class': 'cp-confrow' }, [
        h('div', { 'class': 'cp-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Confidence' }, [fill]),
        h('span', { 'class': 'cp-pct', text: pct + '% sure' })
      ]));
      card.appendChild(h('p', { 'class': 'cp-reason', text: c.reason || 'The analysis is not sure about this one.' }));
      card.appendChild(h('div', { 'class': 'cp-actions' }, [
        btn('Preview', '', function () { previewCand(c); }, 'play', 'Play from 1.2 s before to 1.2 s after (Space)'),
        btn('Accept', 'cp-btn-ok', function () { selectCard(c.id, { reveal: false, transcript: false }); acceptCand(c); }, 'check', 'Cut this (A)'),
        btn('Reject', 'cp-btn-no', function () { selectCard(c.id, { reveal: false, transcript: false }); rejectCand(c); }, 'x', 'Keep this (R)')
      ]));
      on(card, 'click', function (e) {
        var t = e.target;
        if (t && t.closest && t.closest('button')) { return; }
        selectCard(c.id, { reveal: false, transcript: true });
      });
      on(card, 'focusin', function () { if (S.selCard !== c.id) { selectCard(c.id, { reveal: false, transcript: false }); } });
      setCardTab(card, c.id === S.selCard);
      return card;
    }

    function setCardTab(el, active) {
      var bs = el.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) { if (active) { bs[i].removeAttribute('tabindex'); } else { bs[i].setAttribute('tabindex', '-1'); } }
    }
    function selectCard(id, o) {
      o = o || {};
      var prev = S.selCard;
      var c = id ? S.candById[id] : null;
      S.selCard = c ? id : '';
      if (c) { S.selStart = c.start; }
      if (prev && prev !== S.selCard) {
        var pe = cardEls.get(prev);
        if (pe) { pe.className = 'cp-card ' + kindClass(S.candById[prev] ? S.candById[prev].kind : ''); pe.setAttribute('tabindex', '-1'); pe.removeAttribute('aria-current'); setCardTab(pe, false); }
      }
      var el = S.selCard ? cardEls.get(S.selCard) : null;
      if (el) {
        el.className = 'cp-card cp-card-sel ' + kindClass(c.kind); el.setAttribute('tabindex', '0'); el.setAttribute('aria-current', 'true'); setCardTab(el, true);
        if (o.reveal !== false) { revealInQueue(el); }
        if (o.focus) { try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } revealInPanel(el); }
      }
      if (prev !== S.selCard) { repaintCand(prev); repaintCand(S.selCard); }
      if (c && o.transcript !== false) { revealToken(firstTokenOf(c), true); }
    }
    function revealInQueue(el) {
      var l = E.queue;
      if (!l || el.offsetTop === undefined) { return; }
      if (el.offsetTop < l.scrollTop) { l.scrollTop = Math.max(0, el.offsetTop - 4); }
      else if (el.offsetTop + el.offsetHeight > l.scrollTop + l.clientHeight) { l.scrollTop = el.offsetTop + el.offsetHeight - l.clientHeight + 4; }
    }
    /**
     * Keep a card the keyboard moved to in view inside the panel's own scroll area. The panel (.cp-root) is the scroller, so its
     * scrollTop is changed directly: scrollIntoView() would also scroll every ancestor, i.e. the page.
     */
    function revealInPanel(el) {
      var root = E.root;
      if (!root || !el || typeof el.getBoundingClientRect !== 'function' || typeof root.getBoundingClientRect !== 'function') { return; }
      try {
        var r = root.getBoundingClientRect(), c = el.getBoundingClientRect(), pad = 6, delta = 0;
        if (!r || !c || !isFinite(r.top) || !isFinite(r.bottom) || !isFinite(c.top) || !isFinite(c.bottom)) { return; }
        if (c.top < r.top + pad) { delta = c.top - r.top - pad; }
        else if (c.bottom > r.bottom - pad) { delta = c.bottom - r.bottom + pad; }
        if (delta > 0 && c.top - delta < r.top + pad) { delta = c.top - r.top - pad; }      // taller than the panel: show its top
        if (delta) { root.scrollTop = Math.max(0, (root.scrollTop || 0) + delta); }
      } catch (e) { /* ignore */ }
    }
    function moveCard(delta) {
      var want = visibleList();
      if (!want.length) { return false; }
      var i = -1;
      for (var k = 0; k < want.length; k++) { if (want[k].id === S.selCard) { i = k; break; } }
      var j = clamp(i < 0 ? 0 : i + delta, 0, want.length - 1);
      selectCard(want[j].id, { reveal: true, focus: true, transcript: true });
      return true;
    }

    /* ---------------- lists ---------------- */
    function rowFromLink(l) {
      var c = candForLink(l);
      return { kind: l.kind, start: l.start, end: l.end, text: (c && c.text) || l.comment || '', link: l, cand: c };
    }
    function makeRow(item, actionLabel, actionHandler, actionIcon) {
      var info = kindInfo(item.kind);
      var tBtn = h('button', { type: 'button', 'class': 'cp-time', title: 'Jump to this moment', text: formatTime(item.start) });
      on(tBtn, 'click', function () { seekTo(item.start); });
      var label = item.text || (item.cand ? placeholderText(item.cand) : formatLen(item.end - item.start));
      return h('div', { 'class': 'cp-row ' + kindClass(item.kind) }, [
        h('span', { 'class': 'cp-badge', text: info.label, title: info.help }),
        tBtn,
        h('span', { 'class': 'cp-rtext', text: label, title: label }),
        h('span', { 'class': 'cp-sub', text: formatLen(item.end - item.start) }),
        h('span', { 'class': 'cp-rbtns' }, [
          btn('Preview', 'cp-btn-sm', function () { previewRange(item.start, item.end); }, 'play'),
          btn(actionLabel, 'cp-btn-sm', function () { actionHandler(item); }, actionIcon)
        ])
      ]);
    }
    function fillRows(name, items, actionLabel, handler, actionIcon, emptyText) {
      var L = E.lists[name];
      clearEl(L.rows);
      if (!items.length) { L.rows.appendChild(h('div', { 'class': 'cp-empty', text: emptyText })); return; }
      var shown = items.slice(0, L.limit);
      shown.forEach(function (it) { L.rows.appendChild(makeRow(it, actionLabel, handler, actionIcon)); });
      if (items.length > shown.length) {
        L.rows.appendChild(btn('Show ' + Math.min(ROW_PAGE, items.length - shown.length) + ' more (' + (items.length - shown.length) + ' hidden)', 'cp-btn-ghost', function () { L.limit += ROW_PAGE; renderLists(); }));
      }
    }
    function renderLists() {
      var has = !!S.transcript || S.links.length > 0;
      setHidden(E.secLists, !has);
      renderDisclosures();
      var autoLinks = S.links.filter(function (l) { return l.auto; });
      var mine = S.links.filter(function (l) { return !l.auto; });
      var rejected = S.candidates.filter(function (c) { return c.st === 'rejected'; });
      E.undoAll.disabled = !autoLinks.length;
      if (S.ui.applied) {
        fillRows('applied', autoLinks.map(rowFromLink), 'Undo', undoAutoItem, 'undo', 'No automatic cuts are applied.');
      }
      if (S.ui.mine) {
        fillRows('mine', mine.map(rowFromLink), 'Remove', removeMineItem, 'trash', 'You have not accepted or drawn any cuts yet.');
      }
      if (S.ui.rejected) {
        fillRows('rejected', rejected.map(function (c) { return { kind: c.kind, start: c.start, end: c.end, text: c.text || '', cand: c }; }), 'Restore', restoreItem, 'undo', 'Nothing rejected.');
      }
    }

    /* ---------------- everything ---------------- */
    function renderAll(keepScroll) {
      var had = inPanel() && doc.activeElement !== E.root;
      renderHeader();
      renderDisclosures();
      rebuildTranscript(!!keepScroll);
      renderQueue(true);
      renderLists();
      renderFloat();
      renderSearchCount();
      if (had && focusStranded()) { restoreFocus(); }      // e.g. Settings closed itself because a transcript opened
    }
    function afterChange() {
      refreshCutFlags();
      paintAll();
      renderHeader();
      renderQueue(false);
      renderLists();
      renderFloat();
    }

    /* ===========================================================================================
     * rendering: the transcript
     * ======================================================================================= */
    function firstTokenOf(c) {
      var ci = S.candidates.indexOf(c);
      var t = ci >= 0 ? S.candToks[ci] : null;
      return t && t.length ? t[0] : -1;
    }
    function mapCandidates() {
      S.tokCand = new Array(S.tokens.length); S.candToks = new Array(S.candidates.length);
      var i, k;
      for (i = 0; i < S.tokCand.length; i++) { S.tokCand[i] = -1; }
      for (i = 0; i < S.candidates.length; i++) {
        var c = S.candidates[i], list = [];
        if (c.words && c.words.length) {
          for (k = 0; k < c.words.length; k++) { var ti = S.wordTok[c.words[k]]; if (ti !== undefined) { list.push(ti); } }
        } else if (S.chipTok[i] !== undefined) { list.push(S.chipTok[i]); }
        list.sort(function (a, b) { return a - b; });
        S.candToks[i] = list;
        for (k = 0; k < list.length; k++) { S.tokCand[list[k]] = i; }
      }
    }
    function tokClass(i) {
      var t = S.tokens[i];
      if (!t) { return 'cp-w'; }
      var cls = t.k ? 'cp-w cp-gap' : 'cp-w';
      var ci = S.tokCand[i];
      if (ci >= 0) {
        var c = S.candidates[ci];
        cls += ' ' + kindClass(c.kind) + (c.st === 'pending' ? ' cp-pend' : (c.st === 'rejected' ? ' cp-rej' : ' cp-app'));
        if (S.selCard && c.id === S.selCard) { cls += ' cp-fc'; }
      }
      if (S.cutFlags[i]) { cls += ' cp-cut'; }
      if (S.hitFlag[i]) { cls += S.hitFlag[i] === 2 ? ' cp-hitc' : ' cp-hit'; }
      if (S.selA >= 0 && i >= Math.min(S.selA, S.selB) && i <= Math.max(S.selA, S.selB)) { cls += ' cp-sel'; }
      if (i === S.cur) { cls += ' cp-now'; }
      return cls;
    }
    function paintToken(i) {
      var el = V.tokEl[i];
      if (!el) { return; }
      var c = tokClass(i);
      if (el.className !== c) { el.className = c; }
    }
    function paintAll() { for (var k in V.tokEl) { if (Object.prototype.hasOwnProperty.call(V.tokEl, k)) { paintToken(+k); } } }
    function repaintCand(id) {
      if (!id) { return; }
      var c = S.candById[id]; if (!c) { return; }
      var ci = S.candidates.indexOf(c), list = ci >= 0 ? S.candToks[ci] : null;
      if (list) { for (var i = 0; i < list.length; i++) { paintToken(list[i]); } }
    }
    function refreshCutFlags() {
      var cuts = getCutsSafe().map(function (c) { return { start: +c.start, end: +c.end }; });
      var flags = flagCutTokens(S.tokens, cuts);
      S.cutFlags = flags;
    }

    function rebuildTranscript(keepScroll) {
      var topTok = -1;
      if (keepScroll && V.vl && V.chunks.length) {
        var ci0 = V.vl.indexAt(E.tscroll.scrollTop);
        if (V.chunks[ci0]) { topTok = V.chunks[ci0].from; }
      }
      var has = !!S.transcript;
      setHidden(E.secTx, !has);
      S.cur = -1;
      S.selA = S.selB = S.anchor = -1; drag = null;      // word numbers change when the words are rebuilt
      V.tokEl = {}; V.rendered = {}; V.chunkEls = []; V.chunks = []; V.vl = null; V.chunkOfTok = [];
      clearEl(E.tinner);
      if (!has) { S.tokens = []; S.cutFlags = []; S.hitFlag = []; return; }
      var built = buildTokens(S.transcript.words || [], S.candidates);
      S.tokens = built.tokens; S.wtoks = built.wtoks; S.wordTok = built.wordTok; S.chipTok = built.chipTok;
      mapCandidates();
      refreshCutFlags();
      S.hitFlag = new Array(S.tokens.length);
      V.chunks = chunkTokens(S.tokens, CHUNK_TOKENS);
      var cnts = V.chunks.map(function (c) { return c.to - c.from; });
      V.vl = new VList(cnts, V.perToken, 24);
      for (var i = 0; i < V.chunks.length; i++) {
        for (var t = V.chunks[i].from; t < V.chunks[i].to; t++) { V.chunkOfTok[t] = i; }
        var el = h('div', { 'class': 'cp-chunk', 'data-c': i });
        el.style.height = V.vl.h[i] + 'px';
        V.chunkEls.push(el);
        E.tinner.appendChild(el);
      }
      if (topTok >= 0 && V.chunkOfTok[topTok] !== undefined) { E.tscroll.scrollTop = V.vl.offset(V.chunkOfTok[topTok]); }
      else if (!keepScroll) { E.tscroll.scrollTop = 0; }
      updateWindow();
      runSearch(true);
      highlightAt(safe(function () { return num(api.getTime(), 0); }, 0));
    }

    function makeTokenEl(t) {
      var tok = S.tokens[t];
      return h('span', { 'class': tokClass(t), 'data-t': t, text: tok.t });
    }
    function renderChunk(i) {
      var ch = V.chunks[i], el = V.chunkEls[i];
      if (!ch || !el || V.rendered[i]) { return; }
      el.style.height = '';
      var frag = doc.createDocumentFragment();
      for (var t = ch.from; t < ch.to; t++) {
        var sp = makeTokenEl(t);
        V.tokEl[t] = sp;
        frag.appendChild(sp); frag.appendChild(doc.createTextNode(' '));
      }
      el.appendChild(frag);
      V.rendered[i] = true;
    }
    function unrenderChunk(i) {
      var ch = V.chunks[i], el = V.chunkEls[i];
      if (!ch || !el || !V.rendered[i]) { return; }
      clearEl(el);
      for (var t = ch.from; t < ch.to; t++) { delete V.tokEl[t]; }
      delete V.rendered[i];
      el.style.height = V.vl.h[i] + 'px';
    }
    /** render the blocks near the viewport, drop the far ones, keep the visible text where it is */
    function updateWindow() {
      var vl = V.vl, sc = E.tscroll;
      if (!vl || !vl.n) { return; }
      var top = sc.scrollTop, vh = Math.max(sc.clientHeight || 0, 240);
      var r = vl.range(top - vh, top + vh * 2);
      var keepLo = vl.indexAt(top - vh * 3), keepHi = vl.indexAt(top + vh * 4);
      var a = vl.indexAt(top), rel = vl.offset(a) - top;
      var newly = [], i;
      for (i = r.first; i <= r.last; i++) { if (!V.rendered[i]) { renderChunk(i); newly.push(i); } }
      var drop = [];
      for (var k in V.rendered) { if (Object.prototype.hasOwnProperty.call(V.rendered, k)) { var ci = +k; if (ci < keepLo || ci > keepHi) { drop.push(ci); } } }
      if (!newly.length && !drop.length) { return; }
      newly.forEach(function (ix) { vl.measure(ix, V.chunkEls[ix].offsetHeight); });
      drop.forEach(unrenderChunk);
      vl.learn(); V.perToken = vl.perToken;
      for (i = 0; i < vl.n; i++) { if (!V.rendered[i]) { V.chunkEls[i].style.height = vl.h[i] + 'px'; } }
      var want = vl.offset(a) - rel;
      if (Math.abs(want - top) > 0.5) { sc.scrollTop = Math.max(0, want); }
    }
    /** bring a token into view inside the transcript box (never scrolls the page) */
    function revealToken(i, center) {
      if (i === undefined || i < 0 || !V.vl) { return; }
      var sc = E.tscroll, ci = V.chunkOfTok[i];
      if (ci === undefined) { return; }
      var el = V.tokEl[i];
      if (!el) { sc.scrollTop = Math.max(0, V.vl.offset(ci) - 10); updateWindow(); el = V.tokEl[i]; }
      if (!el) { return; }
      var top = sc.scrollTop, vh = sc.clientHeight || 300, y = el.offsetTop, hgt = el.offsetHeight || 18;
      if (center || y < top + 4 || y + hgt > top + vh - 4) { sc.scrollTop = Math.max(0, y - vh * (center ? 0.4 : 0.3)); }
    }
    function highlightAt(t) {
      if (destroyed || !S.tokens.length) { return; }
      var i = findTokenAt(S.tokens, t, 0.6);
      if (i === S.cur) { return; }
      var old = S.cur;
      S.cur = i;
      paintToken(old); paintToken(i);
      if (i >= 0 && S.ui.follow && Date.now() - S.lastUserScroll > 2500) { revealToken(i, false); }
    }

    /* ---------------- selection + dragging ---------------- */
    function tokenFromEvent(e) {
      var t = e.target;
      var sp = t && t.closest ? t.closest('[data-t]') : null;
      return sp ? parseInt(sp.getAttribute('data-t'), 10) : -1;
    }
    function setSelection(a, b) {
      var oa = S.selA, ob = S.selB;
      S.selA = a; S.selB = b;
      var lo = Math.min(oa < 0 ? a : oa, a < 0 ? oa : a, ob < 0 ? b : ob, b < 0 ? ob : b);
      var hi = Math.max(oa, ob, a, b);
      if (lo < 0) { lo = 0; }
      for (var i = lo; i <= hi; i++) { paintToken(i); }
    }
    function clearSelection() { if (S.selA >= 0) { setSelection(-1, -1); } S.anchor = -1; renderFloat(); }
    function selRange() {
      if (S.selA < 0) { return null; }
      return selectionToRange(S.tokens, S.selA, S.selB, PAD, duration());
    }
    function wireTranscriptEvents() {
      on(E.tinner, 'mousedown', function (e) {
        if (e.button) { return; }
        var i = tokenFromEvent(e);
        if (i < 0) { return; }
        e.preventDefault();
        try { E.tscroll.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
        S.lastUserScroll = 0;
        if (e.shiftKey && S.anchor >= 0) { setSelection(S.anchor, i); drag = null; renderFloat(); return; }
        // a plain press selects nothing by itself: only a drag (or Shift-click from this word) makes a selection
        if (S.selA >= 0) { setSelection(-1, -1); }
        S.anchor = i;
        drag = { anchor: i, moved: false };
        renderFloat();
      });
      on(E.tinner, 'mouseover', function (e) {
        if (!drag) { return; }
        var i = tokenFromEvent(e);
        if (i < 0 || i === S.selB) { return; }
        if (i === drag.anchor && !drag.moved) { return; }
        if (i !== drag.anchor) { drag.moved = true; }
        setSelection(drag.anchor, i);
      });
      var up = function () {
        if (!drag) { return; }
        var d = drag; drag = null;
        if (!d.moved) { var tok = S.tokens[d.anchor]; if (tok) { seekTo(tok.s); } }
        renderFloat();
      };
      doc.addEventListener('mouseup', up);
      offs.push(function () { doc.removeEventListener('mouseup', up); });
      E.tscroll.addEventListener('wheel', function () { S.lastUserScroll = Date.now(); }, { passive: true });
      E.tscroll.addEventListener('touchmove', function () { S.lastUserScroll = Date.now(); }, { passive: true });
      // dragging the scrollbar (the press lands on the box itself, not on a word) and scrolling with the keyboard
      var barPress = function (e) { if (tokenFromEvent(e) < 0) { S.lastUserScroll = Date.now(); } };
      on(E.tscroll, 'mousedown', barPress);
      on(E.tscroll, 'pointerdown', barPress);
      on(E.tscroll, 'keydown', function (e) { if (SCROLL_KEYS[e.key]) { S.lastUserScroll = Date.now(); } });
      on(E.tscroll, 'scroll', function () {
        if (V.raf) { return; }
        V.raf = true;
        schedule(function () { V.raf = false; if (!destroyed) { updateWindow(); } });
      });
      if (typeof win.ResizeObserver === 'function') {
        try {
          var ro = new win.ResizeObserver(function () {
            var w = E.tscroll.clientWidth;
            if (!V.vl) { return; }
            if (w && Math.abs(w - V.lastW) > 2) {
              V.lastW = w; V.vl.resetMeasured();
              for (var k in V.rendered) { if (Object.prototype.hasOwnProperty.call(V.rendered, k)) { V.vl.measure(+k, V.chunkEls[+k].offsetHeight); } }
              V.vl.learn();
            }
            updateWindow();
          });
          ro.observe(E.tscroll);
          offs.push(function () { ro.disconnect(); });
        } catch (e2) { /* ignore */ }
      }
    }

    /* ---------------- floating bar ---------------- */
    function selectedCutState() {
      // returns { anyUncut, anyCut, own: [links] } for the selected tokens
      var lo = Math.min(S.selA, S.selB), hi = Math.max(S.selA, S.selB), anyUncut = false, anyCut = false, own = {}, ownList = [];
      for (var i = lo; i <= hi; i++) {
        if (S.cutFlags[i]) {
          anyCut = true;
          var mid = (S.tokens[i].s + S.tokens[i].e) / 2;
          for (var k = 0; k < S.links.length; k++) {
            var l = S.links[k];
            if (mid >= l.start && mid <= l.end && !own[l.id]) { own[l.id] = true; ownList.push(l); }
          }
        } else { anyUncut = true; }
      }
      return { anyUncut: anyUncut, anyCut: anyCut, own: ownList };
    }
    function renderFloat() {
      if (!E.float) { return; }
      if (S.selA < 0 || !S.tokens.length) { E.float.hidden = true; return; }
      var r = selRange();
      if (!r) { E.float.hidden = true; return; }
      var st = selectedCutState();
      E.float.hidden = false;
      E.floatInfo.textContent = (r.words ? r.words + ' ' + plural(r.words, 'word', 'words') : 'gap') + ' \u00b7 ' + formatLen(r.end - r.start) + ' \u00b7 ' + r.text;
      E.cutBtn.hidden = !st.anyUncut;
      E.uncutBtn.hidden = !st.anyCut;
    }
    function previewSelection() { var r = selRange(); if (r) { previewRange(r.start, r.end); } }

    /* ---------------- search ---------------- */
    function runSearch(keep) {
      var q = E.search ? E.search.value : '';
      S.query = q;
      var oldHits = S.hits;
      S.hits = S.tokens.length ? searchTokens(S.tokens, S.wtoks, q) : [];
      S.hitFlag = new Array(S.tokens.length);
      if (!keep || S.hitCur >= S.hits.length) { S.hitCur = S.hits.length ? 0 : -1; }
      if (!S.hits.length) { S.hitCur = -1; }
      markHits(oldHits);
      renderSearchCount();
      if (!keep && S.hits.length) { revealToken(S.hits[0].a, true); }      // typing shows match 1 (Enter goes on to the next)
    }
    function markHits(oldHits) {
      var k, i;
      for (k = 0; k < S.hits.length; k++) { for (i = S.hits[k].a; i <= S.hits[k].b; i++) { S.hitFlag[i] = k === S.hitCur ? 2 : 1; } }
      var touched = {};
      (oldHits || []).forEach(function (hh) { for (var j = hh.a; j <= hh.b; j++) { touched[j] = true; } });
      S.hits.forEach(function (hh) { for (var j = hh.a; j <= hh.b; j++) { touched[j] = true; } });
      for (var t in touched) { if (Object.prototype.hasOwnProperty.call(touched, t)) { paintToken(+t); } }
    }
    function renderSearchCount() {
      if (!E.hitCount) { return; }
      var q = E.search.value;
      E.hitCount.textContent = !q ? '' : (S.hits.length ? (S.hitCur + 1) + ' of ' + S.hits.length : 'No match');
      E.prevHit.disabled = E.nextHit.disabled = S.hits.length < 2;
    }
    function showHit(idx, seek) {
      if (!S.hits.length) { return; }
      var old = S.hits.slice();
      S.hitCur = (idx % S.hits.length + S.hits.length) % S.hits.length;
      S.hitFlag = new Array(S.tokens.length);
      markHits(old);
      renderSearchCount();
      var hit = S.hits[S.hitCur];
      revealToken(hit.a, true);
      if (seek) { seekTo(S.tokens[hit.a].s); }
    }
    function gotoHit(delta) { if (S.hits.length) { showHit(S.hitCur + delta, true); } }

    /* ===========================================================================================
     * actions
     * ======================================================================================= */
    function pushUndo(entry) { S.undo.push(entry); if (S.undo.length > MAX_UNDO) { S.undo.shift(); } syncKeysHint(); }
    function applyDecisions() {
      S.shadow = {}; S.pageMade = new WeakSet();          // the user did something here: the Rejects kept aside while the panel only followed the page are not coming back, and the Rejects it wrote itself are the card's decision now
      // With no transcript loaded there are no candidates, so reconciling would remove every automatic cut on the page.
      // Only the bookkeeping is brought up to date then.
      if (!S.transcript) { S.links = scanLinks(); rememberLinks(S.links); persistKnown(); afterChange(); return; }
      reclassify();
      reconcileNow(false, 'decision');
      persistDecisions(); persistKnown();
      afterChange();
    }
    /** what the page needs to make one of the panel's cuts again exactly as it was: its range, its note and who made it */
    function specOf(l) {
      return {
        start: l.start, end: l.end, comment: l.comment,
        origin: { kind: l.kind, confidence: l.confidence == null ? 1 : l.confidence, auto: !!l.auto, candidateId: l.cid || ('manual:' + Math.round(l.start * 100)), reason: l.reason || (l.kind === 'manual' ? 'You marked this to be cut.' : ''), by: 'cleanup-panel' }
      };
    }
    /** is this a note the panel writes itself for a cut of that kind (commentFor): "Dead space: [silence 8.1 s]", "Um / er: <quoted word>", "Stutter: 0.28 s" */
    function engineNote(kind, note) {
      var lead = kindInfo(kind).label + ': ';
      return note.indexOf(lead) === 0 && /^(\[[^\]]*\]|\u201c[^\u201d]*\u201d|\d[\d:.]*( s)?)$/.test(note.slice(lead.length));
    }
    /**
     * Does an Accept keep the automatic cut it replaces (plan.swaps) as it is, with its range and its note, or make the card's own cut?
     * The cut that fits its card by id or start is the card's: the user may have trimmed it or written on it, so it stays. One that fits
     * by overlap alone (the card moved: "Leave a pause of" or the minimum gap was different when it was made, or a session saved under
     * other settings) has the range of those settings, which is not the card the user looked at and accepted. It stays only when it
     * shows an edit of the user's: a note that the panel does not write for a cut of its kind.
     */
    function keepsOwnCut(s) {
      var note = typeof s.link.comment === 'string' ? s.link.comment : '';      // a page that hands back anything but text has no user note
      return !s.overlap || (!!note && !engineNote(s.link.kind, note));
    }
    /** does the page cover this cut already (a cut that page undo or a loaded session brought back)? cuts: the page's cuts as the caller read them (optional) */
    function specCovered(spec, cuts) {
      return spec.end > spec.start && coveredLength(spec.start, spec.end, cuts) >= 0.98 * (spec.end - spec.start);
    }
    /**
     * The cuts a step took out of the page that Z could not simply make again from their card: a cut the user trimmed or wrote a note
     * on, or an automatic cut that sat on a card waiting for a decision. links0: the panel's cuts before the step; st0: the state of
     * every card before it. They go into the undo entry as they were, so that Z brings back exactly those cuts.
     */
    function lostSpecs(links0, st0) {
      var here = {}, cids = {}, out = [], tol = Math.max(DECISION_TOL, fps() ? 1.5 / fps() : 0), dur = duration();
      getCutsSafe().forEach(function (c) { if (c) { here[c.id] = true; if (c.origin && typeof c.origin.candidateId === 'string') { cids[c.origin.candidateId] = true; } } });
      links0.forEach(function (l) {
        if (here[l.id] || l.kind === 'manual') { return; }
        var c = l.cid ? S.candById[l.cid] : null;
        if (c && c.kind !== l.kind) { c = null; }
        if (!c) { c = candForLink(l); }
        if (!c) { return; }
        var was = st0[c.id];
        if (was === 'auto' || was === 'accepted') {
          var plain = (was === 'auto') === !!l.auto && Math.abs(l.start - Math.max(0, c.start)) <= tol &&
            Math.abs(l.end - (dur > 0 ? Math.min(dur, c.end) : c.end)) <= tol && l.comment === commentFor(c);
          if (plain || cids[c.id]) { return; }      // Z makes the same cut again from the card (or the page has a cut for the card again)
        }
        out.push(specOf(l));
      });
      return out;
    }
    /**
     * Z: put back the cuts lostSpecs saved. What the page holds now for such a card (the cut the step made for it) gives way: the cut
     * with the same candidate id, and, for an automatic cut that sat on a card waiting for a decision, the accepted cut an Accept made
     * for that card in its place (it carries the card's id, which is not the id of the cut it replaced, and it covers the same time, so
     * the cut would otherwise look as if the page had it already). A cut whose card will not keep it (the card is rejected, or it waits
     * for a decision and the cut is an accepted one: the page's undo and redo took the Accept away meanwhile) is not made again only to
     * be taken out by the next line of Z. Returns how many were left out (skipped) and how many the page would not take (refused).
     */
    function restoreSpecs(specs) {
      var skipped = 0, refused = 0, cuts = getCutsSafe();      // read once: every api.getCuts() copies all the cuts, and a big Accept all has thousands of specs
      function waiting(o) { var w = S.candById[o.candidateId]; return !!w && w.kind === o.kind && w.st === 'pending'; }
      specs.forEach(function (sp) {
        var card = sp.origin.kind === 'manual' ? null : candForLink({ cid: sp.origin.candidateId, kind: sp.origin.kind, start: sp.start, end: sp.end });
        if (card && card.kind !== sp.origin.kind) { card = null; }
        if (card && (card.st === 'rejected' || (card.st === 'pending' && !sp.origin.auto))) { skipped++; return; }
        for (var i = cuts.length - 1; i >= 0; i--) {
          var c = cuts[i], o = c && c.origin;
          if (!o || o.kind !== sp.origin.kind) { continue; }
          if (o.candidateId === sp.origin.candidateId) {
            if (Math.abs(c.start - sp.start) <= 0.05 && Math.abs(c.end - sp.end) <= 0.05 && !!o.auto === !!sp.origin.auto) { continue; }      // that very cut
          } else if (!(sp.origin.auto && !o.auto && c.end > sp.start && c.start < sp.end && waiting(o))) { continue; }      // else only the Accept's cut
          removeCutSafe(c); cuts.splice(i, 1);
        }
        if (!readdSpec(sp, cuts) && !specCovered(sp, cuts)) { refused++; }      // false for a cut the page has already, or one it would not take
      });
      return { skipped: skipped, refused: refused };
    }
    /** change decisions, apply them to the page's cuts, remember how to undo */
    function commit(label, mutate) {
      var before = copyDecisions(S.decisions), links0 = S.transcript ? scanLinks() : [], st0 = {};
      S.candidates.forEach(function (c) { st0[c.id] = c.st; });
      mutate();
      S.error = '';
      applyDecisions();                         // may drop a decision again (the page refused the cut), so look at the result
      var changes = diffDecisions(before, S.decisions);
      if (changes.length) {
        var entry = { label: label, changes: changes }, cuts = lostSpecs(links0, st0);
        if (cuts.length) { entry.cuts = cuts; }
        pushUndo(entry);
      }
    }
    /**
     * Undo takes back only the decisions that step made, and only those nobody has changed since: a cut the user deleted in
     * the page after that step stays deleted. Then the card that comes back is highlighted, scrolled into view and focused.
     */
    function undoLast() {
      var u = S.undo.pop();
      if (!u) { toast('Nothing to undo.'); return false; }
      var hadFocus = inPanel(), undone = 0, left = 0, refused = 0;
      var flips = (u.changes || []).filter(function (ch) { return ch.before && ch.after && ch.before.d === 'accept' && ch.after.d === 'reject'; });      // Rejects that Z turns back into the Accept they replaced
      function run() {
        if (u.changes) { undone += revertDecisions(S.decisions, u.changes); }
        if (u.cuts && undone) { reclassify(); var back = restoreSpecs(u.cuts); left = back.skipped; refused = back.refused; }      // the cuts the step took out come back as they were (the card then finds its own cut)
        if (u.fn) { try { if (u.fn() !== false) { undone++; } } catch (e) { /* ignore */ } }      // a cut that the page already has again is not "undone"
        applyDecisions();
      }
      if (u.fn || u.cuts) { batch(run); } else { run(); }      // a Z that changes the page's cuts by hand and by card is still one step in its history
      if (flips.length) { keepRejectsAside(flips); }
      if (!undone) { toast('Could not undo \u201c' + u.label + '\u201d: it was changed again since.'); return true; }
      revealRestored(u, hadFocus);
      var lost = left + refused, why = !refused ? plural(lost, 'it was', 'they were') + ' changed again since.' : left ? '' : 'the page would not add ' + plural(lost, 'it', 'them') + ' again.';
      toast('Undone: ' + u.label + (lost ? '. ' + lost + ' ' + plural(lost, 'cut', 'cuts') + ' could not be put back' + (why ? ': ' + why : '.') : ''));
      return true;
    }
    function revealRestored(u, hadFocus) {
      var pick = null;
      (u.changes || []).forEach(function (ch) {
        var k = ch.after || ch.before;
        if (!k) { return; }
        for (var i = 0; i < S.candidates.length; i++) {
          var c = S.candidates[i];
          if (c.st === 'pending' && c.kind === k.kind && rangeMatch(k.start, k.end, c.start, c.end) >= 0 && (!pick || c.start < pick.start)) { pick = c; }
        }
      });
      if (pick) {
        // a card that comes back under another kind than the one being shown: show that group, so the card can be seen
        if (S.filter !== 'all' && chipIdOf(pick.kind) !== S.filter) { S.filter = chipIdOf(pick.kind); syncQueue(true); }
        selectCard(pick.id, { reveal: true, focus: hadFocus, transcript: true });
      }
    }
    function acceptCand(c) {
      if (!c || c.st === 'accepted') { return; }
      commit('Accept ' + (c.text ? '\u201c' + clip(c.text, 24) + '\u201d' : c.kind), function () { setDecision(S.decisions, c.kind, c.start, 'accept', c.end); });
      if (c.failed) { toast('The page could not add that cut.'); }
    }
    function rejectCand(c) {
      if (!c || c.st === 'rejected') { return; }
      commit('Reject ' + (c.text ? '\u201c' + clip(c.text, 24) + '\u201d' : c.kind), function () { setDecision(S.decisions, c.kind, c.start, 'reject', c.end); });
    }
    /**
     * "Accept all N" / "Reject all N": acts on exactly the cards the queue shows now (the current filter), after a plain
     * question that names the kind and the seconds. The cuts go to the page in one batch, and Z takes them all back in one step.
     */
    function bulkDecide(accept) {
      var list = visibleList(), n = list.length;
      if (!n) { return; }
      var seconds = rangesLength(list.map(function (c) { return { start: c.start, end: c.end }; }));
      if (!ask(bulkQuestion(accept, S.filter, n, seconds))) { return; }
      var d = chipDef(S.filter), word = n === 1 ? d.one : d.many, which = accept ? 'accept' : 'reject';
      commit((accept ? 'Accept all ' : 'Reject all ') + n + ' ' + word, function () {
        list.forEach(function (c) { setDecision(S.decisions, c.kind, c.start, which, c.end); });
      });
      // say what really happened: the page may have refused some cuts (they are back in the queue, and it told the user so)
      var done = accept ? list.filter(function (c) { return c.st === 'accepted'; }).length : n;
      if (accept && done === 0) { toast('None of the ' + n + ' ' + plural(n, 'cut', 'cuts') + ' could be accepted.'); return; }
      toast((accept ? (done < n ? 'Accepted ' + done + ' of ' + n + '.' : 'Accepted ' + n + ' ' + plural(n, 'cut', 'cuts') + '.') : 'Rejected ' + n + ' ' + plural(n, 'cut', 'cuts') + '.') + ' Press Z to undo.');
    }
    function undoAllAuto() {
      var list = S.candidates.filter(function (c) { return c.st === 'auto'; }), seen = {};
      list.forEach(function (c) { seen[c.id] = true; });
      // an automatic cut that the page brought back onto a card that still waits for a decision is in the same list ("Applied
      // automatically") and its Undo rejects that card: so does this button, or the list would still hold those cuts afterwards
      S.links.forEach(function (l) {
        if (!l.auto || l.kind === 'manual') { return; }
        var c = candForLink(l);
        if (c && c.st === 'pending' && !seen[c.id]) { seen[c.id] = true; list.push(c); }
      });
      if (!list.length) { return; }
      if (!ask('Undo all ' + list.length + ' automatic ' + plural(list.length, 'cut', 'cuts') + '? They will be marked as rejected.')) { return; }
      commit('Undo all automatic cuts', function () { list.forEach(function (c) { setDecision(S.decisions, c.kind, c.start, 'reject', c.end); }); });
      toast('Removed ' + list.length + ' automatic ' + plural(list.length, 'cut', 'cuts') + '.');
    }
    function undoAutoItem(item) {
      var c = item.cand;
      if (!c) { removeLinkOnly(item.link, 'Remove cut'); return; }
      rejectCand(c);
    }
    function removeMineItem(item) {
      if (item.cand) { rejectCand(item.cand); return; }
      removeLinkOnly(item.link, item.link.kind === 'manual' ? 'Remove manual cut' : 'Remove cut');
    }
    function restoreItem(item) {
      var c = item.cand;
      if (!c) { return; }
      commit('Restore ' + (c.text ? '\u201c' + clip(c.text, 24) + '\u201d' : c.kind), function () { removeDecision(S.decisions, c.kind, c.start, c.end); });
    }
    /** remove one of the panel's own cuts that is not tied to a candidate (manual cuts) */
    function removeLinkOnly(l, label) {
      // the cut and whatever the Reject then makes the page match (other cuts that sit on the same card) are ONE step in the page's history
      batch(function () { removeLinkOnlyNow(l, label); });
    }
    function removeLinkOnlyNow(l, label) {
      var spec = specOf(l);
      var before = copyDecisions(S.decisions), changes = [];
      removeCutSafe(l);
      // A cut that came from a card has an Accept stored for it. With no card at this level (another cleanup level dropped it)
      // that Accept would stay behind and bring the cut back when the level is changed again, so the removal is recorded too.
      if (l.kind !== 'manual') { setDecision(S.decisions, l.kind, l.start, 'reject', l.end); changes = diffDecisions(before, S.decisions); }
      var entry = { label: label, fn: function () { return readdSpec(spec); } };
      if (changes.length) { entry.changes = changes; }
      pushUndo(entry);
      if (changes.length) { applyDecisions(); return; }
      S.links = scanLinks(); rememberLinks(S.links); persistKnown();
      afterChange();
    }
    /** make a cut again for Z. Returns false when the page has that range cut already (page undo or a loaded session brought it back) or refuses it. */
    function readdSpec(spec, cuts) {
      var id = null;
      if (specCovered(spec, cuts)) { return false; }
      busy++;
      try { id = api.addCut(spec); } catch (e) { id = null; }
      finally { busy--; }
      if (id === null || id === undefined || id === false) { return false; }
      if (!spec.origin.auto) { S.known[id] = { kind: spec.origin.kind, start: spec.start, end: spec.end, auto: false, cid: spec.origin.candidateId }; }      // an automatic cut stays one the panel only follows
      if (cuts) { cuts.push({ id: id, start: spec.start, end: spec.end, origin: spec.origin }); }
      return true;
    }
    /**
     * how many seconds of [start, end] the page's cuts already cover. cuts (optional): the page's cuts as the caller read them once
     * (api.getCuts() copies every cut, so a loop over thousands of specs must not ask again for each one); the caller keeps the list current.
     */
    function coveredLength(start, end, cuts) {
      var src = cuts || getCutsSafe(), near = [], i;
      for (i = 0; i < src.length; i++) { var c = src[i]; if (c && +c.end > start && +c.start < end) { near.push({ start: +c.start, end: +c.end }); } }
      var m = mergeRanges(near, 0), cov = 0;
      for (i = 0; i < m.length; i++) { var ov = Math.min(m[i].end, end) - Math.max(m[i].start, start); if (ov > 0) { cov += ov; } }
      return cov;
    }
    function addManualCut(start, end, comment) {
      var d = duration();
      start = Math.max(0, start); if (d > 0) { end = Math.min(d, end); }
      if (!(end - start >= 0.02)) { return null; }
      if (coveredLength(start, end) >= 0.98 * (end - start)) { return { dup: true }; }      // the page already has this cut
      var spec = {
        start: start, end: end, comment: comment,
        origin: { kind: 'manual', confidence: 1, auto: false, candidateId: 'manual:' + Math.round(start * 100), reason: 'You marked this to be cut.', by: 'cleanup-panel' }
      };
      var id = null;
      busy++;
      try { id = api.addCut(spec); } catch (e) { id = null; }
      finally { busy--; }
      if (id === null || id === undefined || id === false) { return null; }
      S.known[id] = { kind: 'manual', start: start, end: end, auto: false, cid: spec.origin.candidateId };
      pushUndo({ label: 'Cut ' + formatTime(start), fn: function () { removeCutSafe({ id: id }); } });
      S.links = scanLinks(); rememberLinks(S.links); persistKnown();
      return { id: id, start: start, end: end };
    }
    function cutSelection() {
      var r = selRange();
      if (!r) { return; }
      var st = selectedCutState();
      if (!st.anyUncut) { toast('Those words are already cut.'); return; }
      var res = addManualCut(r.start, r.end, 'Manual cut: ' + r.text);
      if (res && res.dup) { toast('Those words are already cut.'); return; }
      if (!res) { toast('The page could not add that cut.'); return; }
      setSelection(-1, -1); S.anchor = -1;
      afterChange();
      toast('Cut ' + formatTime(res.start) + ' to ' + formatTime(res.end) + ' (' + formatLen(res.end - res.start) + ').');
    }
    function uncutSelection() {
      if (S.selA < 0) { return; }
      var st = selectedCutState();
      if (!st.anyCut) { return; }
      if (!st.own.length) { toast('That cut was made somewhere else. Remove it from the marker list instead.'); return; }
      var before = copyDecisions(S.decisions), manualSpecs = [], gone = [], touched = 0, st0 = {};
      S.candidates.forEach(function (c) { st0[c.id] = c.st; });
      st.own.forEach(function (l) {
        var c = l.kind === 'manual' ? null : candForLink(l);
        if (!c) {
          manualSpecs.push(specOf(l));
          if (l.kind !== 'manual') { setDecision(S.decisions, l.kind, l.start, 'reject', l.end); }      // the Accept it came from must not bring it back
          gone.push(l);
        } else {
          setDecision(S.decisions, l.kind, c.start, 'reject', c.end);
        }
        touched++;
      });
      // one click is one step in the page's history, and so is the Z that takes it back
      var entry = { label: 'Uncut', changes: diffDecisions(before, S.decisions), fn: function () {
        var added = false, here = getCutsSafe();
        batch(function () { manualSpecs.forEach(function (sp) { if (readdSpec(sp, here)) { added = true; } }); });
        return added;
      } };
      pushUndo(entry);
      setSelection(-1, -1); S.anchor = -1;
      if (gone.length) { batch(function () { gone.forEach(removeCutSafe); applyDecisions(); }); } else { applyDecisions(); }
      var lost = lostSpecs(st.own, st0);
      if (lost.length) { entry.cuts = lost; }
      toast('Uncut ' + touched + ' ' + plural(touched, 'cut', 'cuts') + '.');
    }
    function previewRange(s, e) {
      var d = duration();
      playRange(Math.max(0, s - PREVIEW_PAD), d > 0 ? Math.min(d, e + PREVIEW_PAD) : e + PREVIEW_PAD);
    }
    function previewCand(c) { previewRange(c.start, c.end); }

    function readTypedRange() {
      var s = parseTime(E.rStart.value), e = parseTime(E.rEnd.value), d = duration();
      function bad(msg) { E.rMsg.className = 'cp-form-msg'; E.rMsg.textContent = msg; return null; }
      if (isNaN(s)) { return bad('The start time is not a time. Type it like 1:23.45 or 83.45.'); }
      if (isNaN(e)) { return bad('The end time is not a time. Type it like 1:25.00 or 85.'); }
      if (e <= s) { return bad('The end must be after the start.'); }
      if (d > 0 && s >= d) { return bad('The start is after the end of the video (' + formatTime(d) + ').'); }
      if (d > 0 && e > d) { e = d; }
      return { start: s, end: e };
    }
    function cutTypedRange() {
      var r = readTypedRange();
      if (!r) { return; }
      var res = addManualCut(r.start, r.end, 'Manual cut: time range ' + formatTime(r.start) + ' to ' + formatTime(r.end));
      if (res && res.dup) { E.rMsg.className = 'cp-form-msg cp-okmsg'; E.rMsg.textContent = 'That time range is already cut.'; toast('That time range is already cut.'); return; }
      if (!res) { E.rMsg.className = 'cp-form-msg'; E.rMsg.textContent = 'The page could not add that cut.'; return; }
      E.rMsg.className = 'cp-form-msg cp-okmsg';
      E.rMsg.textContent = 'Cut added: ' + formatTime(res.start) + ' to ' + formatTime(res.end) + ' (' + formatLen(res.end - res.start) + ').';
      afterChange();
      toast('Cut added: ' + formatTime(res.start) + ' to ' + formatTime(res.end));
    }
    function previewTypedRange() { var r = readTypedRange(); if (r) { E.rMsg.textContent = ''; playRange(r.start, r.end); } }

    /* ---------------- files ---------------- */
    function openPicker() {
      if (typeof api.pickTranscript === 'function') { safe(function () { return api.pickTranscript(); }); return; }
      E.fileInput.click();
    }
    function readFile(file) {
      if (!file) { return; }
      if (file.size > MAX_FILE) { showError('That file is ' + Math.round(file.size / 1048576) + ' MB, which is far too big to be a transcript.'); return; }
      var FR = win.FileReader || (typeof FileReader !== 'undefined' ? FileReader : null);
      if (!FR) { showError('This browser cannot read files here. Paste the transcript through the page instead.'); return; }
      var fr = new FR();
      var fname = typeof file.name === 'string' ? file.name : '';
      fr.onload = function () { if (!destroyed) { load(String(fr.result), fname ? { source: { kind: 'file', name: fname } } : {}); } };
      fr.onerror = function () { showError('That file could not be read.'); };
      fr.readAsText(file);
    }
    function removeTranscript() {
      var mine = ownCuts();
      var msg = mine.length ? 'Remove this transcript and the ' + mine.length + ' ' + plural(mine.length, 'cut', 'cuts') + ' made from it? Cuts you drew by hand stay.' : 'Remove this transcript?';
      if (!ask(msg)) { return; }
      clearTranscript({ removeCuts: true });
    }

    /* ===========================================================================================
     * the "Create transcript" card: make the transcript with the helper on this computer
     * ======================================================================================= */
    var tcBroken = false, lastCreateState = '', lastClientFlag = null;
    function tcApi() {
      if (tcBroken) { return null; }
      var T = options.TranscriberClient;
      if (!T || typeof T.create !== 'function') { T = win.TranscriberClient || (typeof TranscriberClient !== 'undefined' ? TranscriberClient : null); }
      return T && typeof T.create === 'function' ? T : null;
    }
    function clientAvailable() { return !!tcApi(); }
    function getClient() {
      if (tcClient) { return tcClient; }
      var T = tcApi();
      if (!T) { return null; }
      try { tcClient = T.create({ ports: Array.isArray(options.transcriberPorts) && options.transcriberPorts.length ? options.transcriberPorts.slice() : TC_PORTS.slice() }); } catch (e) { tcClient = null; }
      if (!tcClient || typeof tcClient.check !== 'function' || typeof tcClient.run !== 'function') { tcClient = null; tcBroken = true; renderCreate(); }
      return tcClient;
    }
    function pageFile() {
      if (typeof api.getFile !== 'function') { return null; }
      var f = safe(function () { return api.getFile(); }, null);
      return f && typeof f === 'object' ? f : null;
    }
    function setText(el, txt) { if (el && el.textContent !== txt) { el.textContent = txt; } }
    function jobBusy() { return !!S.job && (S.job.state === 'checking' || S.job.state === 'running'); }
    function jobStale(token) { return destroyed || !S.job || S.job.token !== token; }

    function buildCreateCard() {
      E.create = h('div', { 'class': 'cp-create', role: 'region', 'aria-label': 'Create a transcript', hidden: true });
      E.cHead = h('h3', { 'class': 'cp-create-h', text: 'Clean up this video' });
      E.cIntro = h('p', { 'class': 'cp-sub' });
      E.cIntro2 = h('p', { 'class': 'cp-sub' });
      E.cVideo = h('p', { 'class': 'cp-sub' });
      E.cMsg = h('p', { 'class': 'cp-cmsg', role: 'status', tabindex: '-1' });
      E.cClose = btn('Close', 'cp-btn-sm', closeCreateCard, null, 'Hide this message');
      E.cStage = h('p', { 'class': 'cp-stage', role: 'status', tabindex: '-1' });
      E.cFill = h('div', { 'class': 'cp-prog-fill' });
      E.cBar = h('div', { 'class': 'cp-prog', role: 'progressbar', 'aria-label': 'Making the transcript', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, [E.cFill]);
      E.cDetail = h('p', { 'class': 'cp-sub' });
      E.cNote = h('p', { 'class': 'cp-sub' });
      E.cCancel = btn('Cancel', 'cp-btn-sm', cancelJob, null, 'Stop making the transcript. Nothing is kept.');
      E.cRun = h('div', { 'class': 'cp-create-part' }, [E.cStage, E.cBar, E.cDetail, E.cNote, h('div', { 'class': 'cp-create-btns' }, [E.cCancel])]);
      E.cHelpLead = h('p', { tabindex: '-1' });
      E.cSteps = h('ol', { 'class': 'cp-steps' });
      E.cCheck = btn('Check again', 'cp-btn-primary', startCreate, null, 'Look for the helper again');
      E.cWhyHelp = h('p', { 'class': 'cp-why', id: 'cp-why-help-' + uid, hidden: true });
      E.cCheck.setAttribute('aria-describedby', 'cp-why-help-' + uid);
      E.cHelp = h('div', { 'class': 'cp-create-part' }, [E.cHelpLead, E.cSteps, E.cCheck, E.cWhyHelp]);
      E.cBtn = btn('Create transcript and find cuts', 'cp-btn-primary', startCreate, null, 'Make a transcript of the open video with the helper on this computer, then find the cuts');
      E.cWhy = h('p', { 'class': 'cp-why', id: 'cp-why-' + uid, hidden: true });       // why the button above is disabled, in normal text
      E.cBtn.setAttribute('aria-describedby', 'cp-why-' + uid);
      E.cLink = h('button', { type: 'button', 'class': 'cp-link', text: 'I already have a transcript file', title: 'Choose a transcript file you already have' });
      on(E.cLink, 'click', openPicker);
      E.cKeep = h('button', { type: 'button', 'class': 'cp-link', text: 'Keep the current transcript' });
      on(E.cKeep, 'click', closeCreateCard);
      [E.cHead, E.cMsg, E.cClose, E.cIntro, E.cIntro2, E.cVideo, E.cRun, E.cHelp, E.cBtn, E.cWhy, E.cLink, E.cKeep].forEach(function (el) { E.create.appendChild(el); });
      // the video can be opened after the panel was made: look again when the pointer or the keyboard reaches the card
      on(E.create, 'mouseover', lookAgain);
      on(E.create, 'focusin', lookAgain);
    }
    /** the page may have opened a video, or loaded the helper's script, since the card was drawn */
    function lookAgain() {
      if (destroyed) { return; }
      if (clientAvailable() !== lastClientFlag) { renderCreate(); } else { refreshCreateButton(); }
    }
    function refreshCreateButton() {
      if (destroyed || !E.cBtn || E.create.hidden) { return; }
      var file = pageFile(), st = S.job ? S.job.state : 'idle';
      var mainShown = (st === 'idle' || st === 'cancelled' || st === 'error') && clientAvailable();
      E.cBtn.disabled = !file;
      setBtnLabel(E.cBtn, file ? 'Create transcript and find cuts' : 'Open a video first');
      E.cCheck.disabled = !file;
      // the faded label of a disabled button is hard to read and is the only explanation: write the reason out as normal text
      setText(E.cWhy, file ? '' : 'Open a video first, then press the button above.');
      setHidden(E.cWhy, !!file || !mainShown);
      setText(E.cWhyHelp, file ? '' : 'Open a video first, then press Check again.');
      setHidden(E.cWhyHelp, !!file || st !== 'help');
      var name = videoName();
      setText(E.cVideo, file && name ? 'Video: ' + clip(name, 60) : '');
    }
    /** the line after a cancelled job; with a transcript already open it must say that the transcript is still there */
    function cancelledText(job) {
      var text = (job && job.text) || 'Cancelled. Nothing was kept.';
      return S.transcript ? text.replace(/Nothing was kept\./, 'Your current transcript and its cuts were kept.') : text;
    }
    function renderCreate() {
      if (!E.create) { return; }
      var job = S.job, st = job ? job.state : 'idle', client = clientAvailable();
      lastClientFlag = client;
      var show = st !== 'idle' || !S.transcript || S.createOpen;
      var busyNow = st === 'checking' || st === 'running';
      setHidden(E.makeBtn, !(S.transcript && client && !busyNow));
      E.openBtn.className = 'cp-btn' + (show && client ? '' : ' cp-btn-primary');
      var had = !!doc.activeElement && E.create.contains(doc.activeElement);
      setHidden(E.create, !show);
      if (!show) { return; }
      var open = st === 'idle' || st === 'cancelled' || st === 'error';
      setHidden(E.cIntro, st !== 'idle'); setHidden(E.cIntro2, !(st === 'idle' && !client));      // after a message, the message comes first
      setHidden(E.cVideo, !(open && client));
      setHidden(E.cMsg, !(st === 'cancelled' || st === 'error' || st === 'done'));
      setHidden(E.cClose, st !== 'done');
      setHidden(E.cRun, !busyNow);
      setHidden(E.cHelp, st !== 'help');
      setHidden(E.cBtn, !(open && client));
      setHidden(E.cLink, !(open || st === 'help'));
      setHidden(E.cKeep, !(S.transcript && S.createOpen && (open || st === 'help')));
      if (!client) {
        setText(E.cIntro, 'The helper that makes transcripts is not part of this build.');
        setText(E.cIntro2, 'Open a transcript file to find ums, stutters and dead space. Everything is worked out on this computer; nothing is uploaded. You can also drop the file onto this panel.');
      } else if (S.transcript) {
        setText(E.cIntro, 'Make a new transcript from the open video. It replaces the current one.');
      } else {
        setText(E.cIntro, 'Make a transcript on this computer, then find the ums, pauses and repeats. The video goes only to the helper program on this computer.');
      }
      if ((open && client) || st === 'help') { refreshCreateButton(); }
      if (st === 'cancelled') { setText(E.cMsg, cancelledText(job)); E.cMsg.className = 'cp-cmsg'; }
      else if (st === 'error') { setText(E.cMsg, (job && job.text) || ''); E.cMsg.className = 'cp-cmsg cp-warn'; }
      else if (st === 'done') { setText(E.cMsg, (job && job.text) || ''); E.cMsg.className = 'cp-cmsg cp-okn'; }
      if (st === 'help' && job) {
        setText(E.cHelpLead, job.lead || '');
        if (E.cSteps.getAttribute('data-for') !== job.token + ':' + job.code) {
          clearEl(E.cSteps);
          (job.steps || []).forEach(function (s) { E.cSteps.appendChild(h('li', { text: s })); });
          E.cSteps.setAttribute('data-for', job.token + ':' + job.code);
        }
      }
      if (busyNow) { updateProgressUi(); }
      // the control that had the keyboard may be gone now: move the keyboard to what replaced it
      if (had && lastCreateState !== st) {
        var target = busyNow ? E.cStage : (st === 'help' ? E.cHelpLead : (st === 'error' || st === 'cancelled' || st === 'done' ? E.cMsg : null));
        if (target) { try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      }
      lastCreateState = st;
    }
    function updateProgressUi() {
      var job = S.job;
      if (!job || !E.cStage) { return; }
      var pct = Math.round(clamp(num(job.percent, 0), 0, 100)), eta = formatEta(job.eta);
      setText(E.cStage, stageLine(job.phase, job.message));
      E.cFill.style.width = pct + '%';
      E.cBar.setAttribute('aria-valuenow', String(pct));
      setText(E.cDetail, pct + '%' + (eta ? ' \u00b7 ' + eta : ''));
      var note = job.phase === 'transcribing' && job.message ? clip(job.message, 100) : '';
      // the helper's own words are shown under the bar only when they say more than the stage line above it
      function letters(x) { return String(x).toLowerCase().replace(/[^a-z]+/g, ''); }
      if (note && letters(note) === letters(stageLine(job.phase, job.message))) { note = ''; }
      setText(E.cNote, note);
      setHidden(E.cNote, !note);
    }

    function openCreateCard() {
      if (destroyed) { return; }
      S.createOpen = true;
      if (S.job && !jobBusy()) { S.job = null; }          // a finished message gives way to the new start
      renderCreate();
      if (!E.cBtn.hidden && !E.cBtn.disabled) { try { E.cBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }
    function closeCreateCard() {
      if (destroyed) { return; }
      S.createOpen = false;
      if (S.job && !jobBusy()) { S.job = null; }
      renderCreate();
    }

    /** the button (and "Check again"): look for the helper, then make the transcript */
    function startCreate() {
      if (destroyed || jobBusy()) { return; }               // only one run at a time
      var client = getClient();
      if (!client) { renderCreate(); return; }
      var file = pageFile();
      if (!file) {
        // the video was closed since the card was drawn: say so instead of redrawing the same card in silence
        S.job = { state: 'error', token: ++jobSeq, text: 'There is no video open, so there is nothing to make a transcript from. Open a video first, then try again.' };
        renderCreate();
        return;
      }
      var replaceOk = !!(S.job && S.job.state === 'help' && S.job.replaceOk);
      if (S.transcript && !replaceOk) {
        var mine = ownCuts();
        if (!ask('Making a new transcript replaces the current one' + (mine.length ? ' and removes the ' + mine.length + ' ' + plural(mine.length, 'cut', 'cuts') + ' made from it. Cuts you drew by hand stay' : '') + '. Continue?')) { return; }
        replaceOk = true;
      }
      var token = ++jobSeq;
      S.job = { state: 'checking', token: token, replaceOk: replaceOk, startTid: S.tid, phase: 'checking', percent: 0, message: '', eta: null };
      renderCreate();
      var p;
      try { p = client.check(); } catch (e) { p = null; }
      Promise.resolve(p).then(function (r) { return r; }, function () { return null; }).then(function (r) {
        if (jobStale(token)) { return; }
        // r.checking: the helper has only just started and is still looking at its speech tools (r.help: advice of its own, if sent)
        if (!r || !r.found) { showHelp(token, 'no-helper', r && r.problem, { help: r && r.help }); return; }
        if (!r.ready) { showHelp(token, 'not-ready', r.problem, { help: r.help, checking: r.checking === true }); return; }
        if (r.busy) { showHelp(token, 'busy', r.problem, { help: r.help }); return; }
        runJob(client, file, token);
      });
    }
    function nonBlank(v) { return typeof v === 'string' && v.replace(/\s+/g, '') ? v : ''; }
    /**
     * The help card. extra.help is advice that fits this very cause (the client's err.help, or a check result's help); without it
     * TranscriberClient.helpText(code) is used, then the panel's own steps. extra.checking: the helper has only just started.
     */
    function showHelp(token, code, problem, extra) {
      extra = extra || {};
      var T = tcApi(), help = nonBlank(extra.help);
      if (!help) { try { if (T && typeof T.helpText === 'function') { help = nonBlank(T.helpText(code)); } } catch (e) { help = ''; } }
      var card = helpCard(code, problem, help, !!extra.checking);
      S.job = { state: 'help', token: token, code: code, lead: card.lead, steps: card.steps, replaceOk: !!(S.job && S.job.replaceOk), startTid: S.job ? S.job.startTid : S.tid };
      renderCreate();
    }
    function runJob(client, file, token) {
      var job = S.job;
      job.state = 'running'; job.phase = 'checking'; job.percent = 0;
      renderCreate();
      var p;
      try { p = client.run(file, {}, function (pg) { onJobProgress(token, pg); }); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function (tr) { if (!jobStale(token)) { jobDone(token, tr); } }, function (err) { if (!jobStale(token)) { jobFailed(token, err); } });
    }
    function onJobProgress(token, pg) {
      if (jobStale(token)) { return; }
      var job = S.job;
      if (job.state !== 'running' && job.state !== 'checking') { return; }
      pg = pg && typeof pg === 'object' ? pg : {};
      job.state = 'running';
      if (typeof pg.phase === 'string') { job.phase = pg.phase; }
      job.percent = Math.max(num(job.percent, 0), clamp(num(pg.percent, 0), 0, 100));    // the bar never goes backwards
      job.message = typeof pg.message === 'string' ? pg.message.replace(/\s+/g, ' ').replace(/^ | $/g, '') : '';
      job.eta = typeof pg.etaSeconds === 'number' && isFinite(pg.etaSeconds) ? pg.etaSeconds : null;
      updateProgressUi();
    }
    function jobDone(token, tr) {
      var job = S.job;
      var r = load(tr, { source: { kind: 'helper' }, replaceOk: !!job.replaceOk && S.tid === job.startTid });
      if (jobStale(token)) { return; }
      if (r.ok) {
        var n = counts();
        S.createOpen = false;
        S.job = { state: 'done', token: token, text: summaryText({ total: n.total, applied: n.applied, pending: n.pending, saves: n.saves, brief: true }) };
        renderCreate();
      } else if (r.cancelled) {
        S.job = { state: 'cancelled', token: token, text: S.transcript ? 'The new transcript was made, but your current one was kept, as you chose. Make it again to replace the current one.' : 'The new transcript was made, but it was not opened, as you chose. Make it again to open it.' };
        renderCreate();
      } else {
        S.job = { state: 'error', token: token, text: 'The helper finished, but its transcript could not be opened. ' + clip(r.error || '', 300) };
        renderCreate();
      }
    }
    function jobFailed(token, err) {
      var code = err && typeof err.code === 'string' ? err.code : 'failed';
      if (code === 'cancelled') {         // the user's own Cancel never gets here (the job is already stale); this is the helper stopping it
        S.job = { state: 'cancelled', token: token };
        if (err && nonBlank(err.help)) { S.job.text = clip(nonBlank(err.help).replace(/\s+/g, ' '), 400); }
        renderCreate(); return;
      }
      if (code === 'no-helper' || code === 'not-ready' || code === 'busy') {
        var msg = err && typeof err.message === 'string' ? err.message : '';
        showHelp(token, code, msg, { help: err && err.help, checking: !!err && (err.checking === true || (code === 'not-ready' && CHECKING_RE.test(msg))) });
        return;
      }
      S.job = { state: 'error', token: token, text: errorText(err, code) };
      renderCreate();
    }
    /** the advice without its leading sentences that only repeat the message ("There is not enough free space ..." twice) */
    function adviceAfter(msg, advice) {
      function key(x) { return String(x).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24); }
      var parts = splitSteps(advice);
      while (parts.length > 1 && key(parts[0]) === key(msg)) { parts.shift(); }
      return parts.join(' ');
    }
    /** one calm paragraph: what the error says, then what to do next */
    function errorText(err, code) {
      var msg = err && typeof err.message === 'string' ? err.message.replace(/\s+/g, ' ').replace(/^ | $/g, '') : '';
      if (!msg) { msg = 'The transcript could not be made.'; }
      if (!/[.!?]$/.test(msg)) { msg += '.'; }
      // the client's own advice for this very cause first (a recording without sound must not be told to "try once more"),
      // then the general text for the error code, then the panel's own sentence
      // A job that failed inside the helper carries a complete, cause-specific sentence in err.help (it already starts with the
      // cause): show that alone instead of saying the same thing twice.
      if (err && err.jobError && nonBlank(err.help)) { return clip(nonBlank(err.help).replace(/\s+/g, ' '), 400); }
      var T = tcApi(), next = err ? nonBlank(err.help) : '';
      if (!next) { try { if (T && typeof T.helpText === 'function') { next = String(T.helpText(code) || ''); } } catch (e) { next = ''; } }
      if (!next) { next = NEXT_STEP[code] || NEXT_STEP.failed; }
      return clip(msg, 300) + ' ' + clip(adviceAfter(msg, next.replace(/\s+/g, ' ')), 400);
    }
    function cancelJob() {
      if (!jobBusy()) { return; }
      var client = tcClient;
      S.job = { state: 'cancelled', token: ++jobSeq };          // whatever the client still reports for the old job is ignored
      try { if (client && typeof client.cancel === 'function') { var r = client.cancel(); if (r && typeof r.then === 'function') { r.then(null, function () { /* ignore */ }); } } } catch (e) { /* ignore */ }
      renderCreate();
    }

    /* ---------------- keyboard + root events ---------------- */
    function onKeyDown(e) {
      if (destroyed || e.defaultPrevented) { return; }
      if (e.ctrlKey || e.metaKey || e.altKey) { return; }
      var t = e.target, tag = String((t && t.tagName) || '').toUpperCase();
      var itype = String((t && t.type) || '').toLowerCase();
      var typing = (tag === 'INPUT' && itype !== 'checkbox' && itype !== 'radio' && itype !== 'button' && itype !== 'file') || tag === 'TEXTAREA' || tag === 'SELECT' || !!(t && t.isContentEditable);
      if (typing) { return; }
      var key = e.key;
      var k = key && key.length === 1 ? key.toLowerCase() : key;
      var handled = false;
      var inTx = !!(t && t.closest && t.closest('.cp-tx'));
      var sel = S.selCard ? S.candById[S.selCard] : null;
      var held = !!e.repeat;      // a key held down repeats: that must never accept, reject, cut or undo a whole run of items
      if (k === 'j') { handled = moveCard(1); }
      else if (k === 'k') { handled = moveCard(-1); }
      else if (k === 'a') { if (sel && sel.st === 'pending') { if (!held) { acceptCand(sel); } handled = true; } }
      else if (k === 'r') { if (sel && sel.st === 'pending') { if (!held) { rejectCand(sel); } handled = true; } }
      else if (k === 'z') { if (!held) { undoLast(); } handled = true; }
      else if (k === 'x') { if (S.selA >= 0) { if (!held) { cutSelection(); } handled = true; } }
      else if (k === 'Escape') { if (S.selA >= 0) { clearSelection(); handled = true; } }
      else if (k === ' ' || k === 'Spacebar') {
        if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SUMMARY') { return; }
        if (inTx) { if (S.selA >= 0) { if (!held) { previewSelection(); } handled = true; } }
        else if (sel && sel.st === 'pending') { if (!held) { previewCand(sel); } handled = true; }
      }
      if (handled) { e.preventDefault(); if (e.stopPropagation) { e.stopPropagation(); } }
    }
    function hasFiles(e) {
      var dt = e.dataTransfer;
      if (!dt) { return false; }
      if (dt.files && dt.files.length) { return true; }
      var types = dt.types || [];
      for (var i = 0; i < types.length; i++) { if (types[i] === 'Files') { return true; } }
      return false;
    }
    function wireRootEvents(root) {
      on(root, 'keydown', onKeyDown);
      on(root, 'dragover', function (e) { if (hasFiles(e)) { e.preventDefault(); } });
      on(root, 'drop', function (e) {
        if (!hasFiles(e)) { return; }
        e.preventDefault(); e.stopPropagation();
        var f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) { readFile(f); }
      });
    }

    /* ===========================================================================================
     * start up
     * ======================================================================================= */
    function injectStyle() {
      if (doc.getElementById && doc.getElementById('cp-style')) { return; }
      var st = doc.createElement('style');
      st.setAttribute('id', 'cp-style');
      st.textContent = CSS;
      (doc.head || doc.documentElement || host).appendChild(st);
    }

    S.settings = normalizeSettings(jget(KEYS.settings));
    var uiRaw = jget(KEYS.ui) || {};
    // the time-range tool is open unless the user closed it (uiv 2 marks a saved choice; older saves only stored the default).
    // Settings (uiv 4) is not stored: it is open while no transcript is loaded and one line after that (S.setPin holds what the user
    // chose since); "Advanced" is closed until opened, and that is remembered.
    S.ui = {
      advanced: !!uiRaw.advanced, applied: !!uiRaw.applied, mine: !!uiRaw.mine,
      rejected: !!uiRaw.rejected, range: uiRaw.uiv >= 2 ? !!uiRaw.range : true, follow: uiRaw.follow !== false, uiv: 4
    };
    injectStyle();
    host.appendChild(buildSkeleton());
    syncSettingsInputs();

    var unsub = null;
    if (typeof api.onTime === 'function') {
      try { unsub = api.onTime(function (t) { highlightAt(num(t, 0)); }); } catch (e) { unsub = null; }
    }
    offs.push(function () { if (typeof unsub === 'function') { try { unsub(); } catch (e) { /* ignore */ } } });

    /* restore the last session */
    (function restore() {
      var stored = jget(KEYS.transcript);
      var lk = jget(KEYS.links);
      var dec = jget(KEYS.decisions);
      if (stored && stored.transcript && stored.tid) {
        var tid = makeTid(stored.transcript);
        // an id written by an older version looks different; trust it, it is saved again under the new form
        var intact = !/^t2:/.test(String(stored.tid)) || stored.tid === tid;
        var known = intact && lk && lk.tid === stored.tid && lk.map && typeof lk.map === 'object' ? lk.map : {};
        var decisions = intact && dec && dec.tid === stored.tid ? cleanDecisions(dec.list) : [];
        var sv = stored.forVideo && typeof stored.forVideo === 'object' ? stored.forVideo : null;
        // the video it was opened for; when the page did not know its length then (or the record is old), the length the file declares
        var ref = { name: sv ? String(sv.name == null ? '' : sv.name) : '', duration: sv ? num(sv.duration, 0) : 0 };
        if (!(ref.duration > 0)) { ref.duration = num(stored.transcript.video && stored.transcript.video.duration, 0); }
        var now = videoNow(), why = videoDiffers(ref, now);
        if (why) {
          // the saved transcript belongs to another video: keep it, make no cut, let the user decide
          S.dormant = { stored: stored, decisions: decisions, text: dormantText(ref, now, why) };
          S.savedTid = stored.tid; S.known = {};
          S.links = scanLinks(); rememberLinks(S.links);
        } else {
          S.known = known; S.decisions = decisions;
          S.transcript = stored.transcript; S.format = stored.format || ''; S.warnings = Array.isArray(stored.warnings) ? stored.warnings : [];
          S.tid = tid; S.forVideo = sv ? { name: ref.name, duration: ref.duration } : null;
          S.source = cleanSource(stored.source);
          runAnalysis(false, false, true);
        }
      } else {
        S.known = lk && lk.map && typeof lk.map === 'object' ? lk.map : {};
        S.savedTid = (lk && typeof lk.tid === 'string' && lk.tid) || (dec && typeof dec.tid === 'string' && dec.tid) || '';
        S.links = scanLinks(); rememberLinks(S.links);
      }
      renderAll();
    })();

    var ctrl = {
      load: load,
      clear: clearTranscript,
      hasTranscript: function () { return !!S.transcript; },
      /**
       * The page tells the panel that its cuts changed. refreshMarkers() with no argument follows the page (see the file header) and is the
       * only call the page needs after undo, redo and a loaded session. Following the page means: an automatic cut that went away is a Reject; an
       * accepted cut that went away drops its Accept, so the card waits under "Needs your decision", except that a card the settings would apply on
       * their own (or whose card is not there) is recorded as Rejected instead; a cut that came back is taken on; and the panel adds or removes
       * no cut (that would be a new step in the page's history, which cuts off the page's redo).
       * refreshMarkers({ loaded: true }) is for the host to call ONCE, right after File > Load session and nowhere else, instead of the plain
       * call that follows a load (after a plain call the Rejects are already recorded and count as the user's). A session replaces all
       * of the page's cuts, so an automatic cut of this transcript that it lacks was not deleted by the user (a plain call would record it
       * as Rejected, and the Rejects are not in the session file). With this option such a cut is not a Reject: the cards that are applied
       * on their own and have no cut get it back through api.addCut, all in ONE api.batch (one step in the page's history), and a toast says
       * how many. Everything else is as in a plain call: a card the user rejected on this computer stays rejected, accepted cuts and the
       * cuts the session carries are taken on, an accepted cut the session lacks drops its Accept (its card goes back under "Needs your
       * decision", or is recorded as Rejected, silently, when the settings would apply it on their own: as in a plain call), cuts that fit no
       * card are left alone. With no transcript, or when most of the page's cuts of the panel fit no card of this transcript (a
       * session from another transcript), it is a plain call. Calling it again changes nothing. Any other argument (nothing, a string, an
       * object without loaded: true) is ignored: the call is then a plain one.
       */
      refreshMarkers: function (opts) {
        if (destroyed) { return; }
        if (busy > 0) { dirtyWhileBusy = true; return; }
        if (S.transcript) {
          var keep = safe(function () { return !!opts && typeof opts === 'object' && opts.loaded === true; }, false) && safe(sessionLacksOwn, false);
          syncExternal(true, keep);
          reclassify();
          if (adoptRestored(false, keep)) { reclassify(); }
          reconcileNow(false, 'page', keep);
          persistDecisions(); persistKnown();
        } else {
          S.links = scanLinks(); rememberLinks(S.links); persistKnown();
        }
        afterChange();           // also redraws the "Create transcript" card, which re-reads api.getFile()
      },
      summary: function () {
        var n = counts();
        var o = {
          total: n.total, applied: n.applied, pending: n.pending, accepted: n.accepted, rejected: n.rejected, manual: n.manual, savesSeconds: n.saves,
          appliedSeconds: n.appliedSeconds, pendingSeconds: n.pendingSeconds
        };
        if (levelsOn()) { o.level = S.settings.level; }
        return o;
      },
      wordsBetween: function (t0, t1) {
        if (destroyed || !S.transcript || !Array.isArray(S.transcript.words) || !S.transcript.words.length) { return ''; }
        var words = S.transcript.words;
        if (!wordIdx || wordIdx.n !== words.length || wordIdx.src !== words) { wordIdx = buildWordIndex(words); wordIdx.src = words; }
        return wordsInRangeText(words, wordIdx, t0, t1, WORDS_CAP);
      },
      destroy: function () {
        if (destroyed) { return; }
        destroyed = true;
        // a transcript job that is still running is stopped; it never wrote anything to storage, so nothing is left behind
        if (S.job && (S.job.state === 'checking' || S.job.state === 'running') && tcClient && typeof tcClient.cancel === 'function') {
          try { var cr = tcClient.cancel(); if (cr && typeof cr.then === 'function') { cr.then(null, function () { /* ignore */ }); } } catch (e) { /* ignore */ }
        }
        jobSeq++; S.job = null;
        Object.keys(timers).forEach(function (k) { if (timers[k]) { clearTimeout(timers[k]); } });
        offs.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } });
        if (E.root && E.root.parentNode) { E.root.parentNode.removeChild(E.root); }
      }
    };
    return ctrl;
  }

  return {
    version: VERSION,
    create: create,
    css: function () { return CSS; },
    KEYMAP: KEYMAP,
    KEYS: KEYS,
    util: {
      parseTime: parseTime, formatTime: formatTime, formatDuration: formatDuration, formatLen: formatLen, normWord: normWord,
      hashString: hashString, parseFillerList: parseFillerList, mergeRanges: mergeRanges, rangesLength: rangesLength,
      summaryText: summaryText, findDecisionIdx: findDecisionIdx, getDecision: getDecision, setDecision: setDecision,
      removeDecision: removeDecision, copyDecisions: copyDecisions, classifyCandidates: classifyCandidates,
      planReconcile: planReconcile, buildTokens: buildTokens, chunkTokens: chunkTokens, findTokenAt: findTokenAt,
      flagCutTokens: flagCutTokens, selectionToRange: selectionToRange, searchTokens: searchTokens, buildContext: buildContext,
      VList: VList, makeTid: makeTid, normPhrase: normPhrase, rangeMatch: rangeMatch, diffDecisions: diffDecisions,
      revertDecisions: revertDecisions, videoDiffers: videoDiffers, cleanDecisions: cleanDecisions,
      levelNoteText: levelNoteText, chipIdOf: chipIdOf, chipCounts: chipCounts, bulkQuestion: bulkQuestion,
      buildWordIndex: buildWordIndex, wordsInRangeText: wordsInRangeText, stageLine: stageLine, formatEta: formatEta, splitSteps: splitSteps,
      pressCheckAgain: pressCheckAgain, repeatsLead: repeatsLead, helpCard: helpCard
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = CleanupPanel; }
