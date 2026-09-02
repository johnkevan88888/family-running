const ADMIN_DOCUMENT = String.raw`<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <meta name="referrer" content="no-referrer">
    <title>Private Gallery administration</title>
    <link rel="stylesheet" href="/admin.css">
</head>
<body>
    <a class="skip-link" href="#main-content">Skip to the form</a>

    <header class="admin-header">
        <div>
            <p class="admin-kicker">Ace of Race</p>
            <h1>Private Gallery administration</h1>
            <p class="admin-subtitle">Prepare and review one owner-curated Gallery moment at a time.</p>
        </div>
        <span class="protected-badge">Owner access protected</span>
    </header>

    <main id="main-content" class="admin-main">
        <aside class="pilot-warning" aria-labelledby="pilot-warning-title">
            <strong id="pilot-warning-title">Photo-only pilot</strong>
            <p>
                Select one approved JPEG or PNG photograph. Video remains disabled.
                The private original stays behind owner authentication; reviewed public
                derivatives are rebuilt without source metadata.
            </p>
        </aside>

        <p id="app-status" class="app-status" role="status" aria-live="polite">
            Loading the protected workspace…
        </p>
        <div id="error-summary" class="error-summary" role="alert" tabindex="-1" hidden></div>

        <div id="admin-workspace" class="admin-workspace" hidden>
            <section class="admin-panel drafts-panel" aria-labelledby="drafts-title">
                <div class="panel-heading compact-heading">
                    <div>
                        <p class="section-kicker">Continue safely</p>
                        <h2 id="drafts-title">Saved drafts</h2>
                    </div>
                    <button id="refresh-drafts" class="button button-secondary" type="button">Refresh</button>
                </div>
                <p class="panel-help">Open an unfinished draft to resume its private photo upload or review.</p>
                <div id="draft-list" class="draft-list" aria-live="polite"></div>
            </section>

            <section class="admin-panel exclusion-panel" aria-labelledby="athlete-exclusion-title">
                <div class="panel-heading">
                    <div>
                        <p class="section-kicker">Proactive privacy control</p>
                        <h2 id="athlete-exclusion-title">Athlete-wide Gallery exclusion</h2>
                        <p>
                            Start an exclusion for any current public athlete, even when
                            no saved Gallery item is currently tagged with that ID.
                        </p>
                    </div>
                </div>
                <div id="athlete-exclusion-controls" class="athlete-exclusion-controls">
                    <label class="form-field" for="athlete-exclusion-choice">
                        <span>Current public athlete</span>
                        <select id="athlete-exclusion-choice">
                            <option value="">Choose a current public athlete</option>
                        </select>
                        <small>
                            Any current or future Gallery item carrying this athlete tag is
                            blocked as a whole. Names and reasons are not stored in the
                            exclusion record.
                        </small>
                    </label>
                    <button id="athlete-exclusion" class="button button-danger" type="button">
                        Start athlete-wide exclusion
                    </button>
                </div>
            </section>

            <section class="admin-panel form-panel" aria-labelledby="new-draft-title">
                <div class="panel-heading">
                    <div>
                        <p class="section-kicker">New private draft</p>
                        <h2 id="new-draft-title">Describe the Gallery moment</h2>
                        <p>Race and person choices come only from the current public championship export.</p>
                    </div>
                    <span class="step-marker" aria-hidden="true">01</span>
                </div>

                <form id="draft-form" novalidate>
                    <div class="fixed-area" aria-labelledby="site-area-title">
                        <span id="site-area-title">Gallery area</span>
                        <strong id="site-area-label">Checking page context…</strong>
                        <small>Media added here stays in this area. The area cannot be changed on this page.</small>
                    </div>

                    <fieldset class="form-section">
                        <legend>Race details</legend>

                        <div class="field-grid two-columns">
                            <label class="form-field" for="race-date">
                                <span>Race date</span>
                                <select id="race-date" name="race-date" required disabled>
                                    <option value="">Loading races…</option>
                                </select>
                            </label>
                            <label class="form-field" for="race-choice">
                                <span>Event and distance</span>
                                <select id="race-choice" name="race-choice" required disabled>
                                    <option value="">Choose a date first</option>
                                </select>
                            </label>
                        </div>
                    </fieldset>

                    <fieldset class="form-section">
                        <legend>Who is shown?</legend>
                        <p class="field-help">
                            Select public athlete IDs only. Consent is still required when nobody is tagged.
                        </p>
                        <div id="athlete-choices" class="athlete-choices" aria-live="polite">
                            <p class="empty-note">Choose an exact race to see the available people.</p>
                        </div>
                    </fieldset>

                    <fieldset class="form-section">
                        <legend>Public description</legend>
                        <div class="field-grid two-columns">
                            <label class="form-field" for="item-id">
                                <span>Gallery item ID</span>
                                <input id="item-id" name="item-id" type="text" required maxlength="120"
                                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                                    aria-describedby="item-id-help" autocomplete="off">
                                <small id="item-id-help">Lowercase words joined with hyphens, such as summer-5k-finish-line.</small>
                            </label>
                            <div class="form-field">
                                <span>Media type</span>
                                <strong>Photo</strong>
                                <small>Video is not enabled in this pilot.</small>
                                <input id="media-type" name="media-type" type="hidden" value="photo">
                            </div>
                        </div>

                        <label class="form-field" for="item-title">
                            <span>Title</span>
                            <input id="item-title" name="item-title" type="text" required maxlength="120">
                            <small>Short public heading, up to 120 characters.</small>
                        </label>

                        <label class="form-field" for="item-caption">
                            <span>Caption</span>
                            <textarea id="item-caption" name="item-caption" maxlength="600" rows="3"></textarea>
                            <small>Optional public context, up to 600 characters.</small>
                        </label>

                        <label class="form-field" for="item-alt">
                            <span>Alternative text</span>
                            <textarea id="item-alt" name="item-alt" required maxlength="300" rows="3"
                                aria-describedby="item-alt-help"></textarea>
                            <small id="item-alt-help">Describe what is visible for someone who cannot see the media.</small>
                        </label>

                        <label class="check-line">
                            <input id="item-featured" name="item-featured" type="checkbox">
                            <span>Make this eligible for featured Race moments panels</span>
                        </label>
                    </fieldset>

                    <fieldset class="form-section consent-section">
                        <legend>Consent confirmation</legend>
                        <p class="field-help">
                            Confirm consent for every depicted person, independently of the athlete tags above.
                        </p>

                        <label class="check-line important-check">
                            <input id="public-use-confirmed" name="public-use-confirmed" type="checkbox" required>
                            <span>I confirm that every depicted person has approved public use.</span>
                        </label>

                        <fieldset class="nested-fieldset">
                            <legend>Does the media contain anyone under 18?</legend>
                            <div class="choice-row compact-choices">
                                <label class="choice-card">
                                    <input type="radio" name="contains-minors" value="yes" required>
                                    <span>Yes</span>
                                </label>
                                <label class="choice-card">
                                    <input type="radio" name="contains-minors" value="no" required>
                                    <span>No</span>
                                </label>
                            </div>
                        </fieldset>

                        <div id="guardian-confirmation" hidden>
                            <label class="check-line important-check">
                                <input id="guardian-approved" name="guardian-approved" type="checkbox">
                                <span>I confirm that a guardian has approved public use.</span>
                            </label>
                        </div>

                        <label class="form-field" for="evidence-reference">
                            <span>Private evidence reference <em>(optional)</em></span>
                            <input id="evidence-reference" name="evidence-reference" type="text" maxlength="300"
                                autocomplete="off">
                            <small>Use a short private reference only. It never enters the public Gallery manifest.</small>
                        </label>
                    </fieldset>

                    <div class="form-actions">
                        <button id="create-draft" class="button button-primary" type="submit">
                            Save private draft
                        </button>
                    </div>
                </form>
            </section>

            <section id="draft-workspace" class="admin-panel review-panel" aria-labelledby="review-title" hidden>
                <div class="panel-heading">
                    <div>
                        <p class="section-kicker">Private moderation</p>
                        <h2 id="review-title">Private photo upload and review</h2>
                        <p id="review-summary">Open or create a draft to continue.</p>
                    </div>
                    <span class="step-marker" aria-hidden="true">02</span>
                </div>

                <dl id="draft-facts" class="draft-facts"></dl>

                <div class="upload-box">
                    <h3>Private photo upload</h3>
                    <p id="upload-instructions">
                        Choose the exact same file again if you resume an interrupted upload.
                        The original filename is never sent to the server or stored in the object key.
                    </p>
                    <label class="form-field" for="photo-file">
                        <span>JPEG or PNG photograph</span>
                        <input id="photo-file" name="photo-file" type="file"
                            accept=".jpg,.jpeg,.png,image/jpeg,image/png">
                        <small>Maximum 25 MiB and 50 megapixels. The server verifies type, size, and the complete SHA-256.</small>
                    </label>
                    <button id="start-upload" class="button button-primary" type="button">
                        Start private photo upload
                    </button>
                    <div id="upload-progress-wrap" class="upload-progress" hidden>
                        <label for="upload-progress">Upload progress</label>
                        <progress id="upload-progress" value="0" max="100">0%</progress>
                        <p id="upload-progress-text" role="status" aria-live="polite">Waiting to start.</p>
                    </div>
                    <div id="checksum-result" class="checksum-result" hidden>
                        <strong>Verified server checksum</strong>
                        <code id="checksum-value"></code>
                    </div>
                </div>

                <div id="protected-preview" class="protected-preview" hidden>
                    <h3>Protected original preview</h3>
                    <p>This preview remains behind owner authentication and is not a public Gallery URL.</p>
                    <div id="preview-media" class="preview-media"></div>
                </div>

                <div id="moderation-actions" class="moderation-actions">
                    <button id="approve-draft" class="button button-primary" type="button" hidden>
                        Approve for processing
                    </button>
                    <button id="return-draft" class="button button-secondary" type="button" hidden>
                        Return to private review
                    </button>
                    <button id="reopen-draft" class="button button-secondary" type="button" hidden>
                        Reopen rejected draft
                    </button>
                    <button id="reject-draft" class="button button-danger" type="button" hidden>
                        Reject this draft
                    </button>
                </div>

                <div id="withdrawal-controls" class="withdrawal-box" hidden>
                    <h3>Remove or exclude Gallery media</h3>
                    <p>
                        These controls start the protected removal process. They do not
                        mark deletion complete; the media stays withdrawal pending until
                        the public host and required private storage checks are proved.
                    </p>
                    <div class="withdrawal-actions">
                        <button id="editorial-withdrawal" class="button button-danger" type="button">
                            Remove this item from the Gallery
                        </button>
                        <button id="consent-withdrawal" class="button button-danger" type="button">
                            Withdraw consent and remove this item
                        </button>
                    </div>
                </div>
            </section>
        </div>
    </main>

    <script src="/admin.js" defer></script>
</body>
</html>`;

const ADMIN_STYLESHEET = String.raw`:root {
    color-scheme: light;
    font-family: "Segoe UI", Arial, sans-serif;
    line-height: 1.5;
    --navy-950: #0f2438;
    --navy-900: #102a43;
    --navy-800: #1e3a5f;
    --navy-700: #2b5c88;
    --blue-100: #eef3f7;
    --blue-200: #d7e1ea;
    --blue-300: #bdcad6;
    --gold: #ffd700;
    --ink: #172b3d;
    --muted: #53697c;
    --danger: #8e2f2f;
    --danger-bg: #fdf2f2;
    --success: #1f6a45;
    --success-bg: #edf8f2;
    --surface: #ffffff;
    --page: #f4f6f8;
}

* {
    box-sizing: border-box;
}

[hidden] {
    display: none !important;
}

body {
    background: var(--page);
    color: var(--ink);
    margin: 0;
    min-width: 0;
}

button,
input,
select,
textarea {
    font: inherit;
}

button,
input[type="checkbox"],
input[type="radio"],
select {
    cursor: pointer;
}

button:disabled,
input:disabled,
select:disabled,
textarea:disabled {
    cursor: not-allowed;
    opacity: 0.62;
}

.skip-link {
    background: var(--gold);
    color: var(--navy-950);
    font-weight: 900;
    left: 12px;
    padding: 10px 14px;
    position: fixed;
    top: -100px;
    z-index: 20;
}

.skip-link:focus {
    top: 12px;
}

.admin-header {
    align-items: center;
    background: var(--navy-800);
    border-top: 6px solid var(--gold);
    box-shadow: 0 5px 16px rgba(15, 36, 56, 0.22);
    color: white;
    display: flex;
    gap: 24px;
    justify-content: space-between;
    padding: 22px max(24px, calc((100vw - 1240px) / 2));
}

.admin-header h1 {
    font-size: clamp(1.8rem, 4vw, 2.45rem);
    line-height: 1.08;
    margin: 0;
}

.admin-kicker,
.section-kicker {
    font-size: 0.76rem;
    font-weight: 900;
    letter-spacing: 0.09em;
    margin: 0 0 5px;
    text-transform: uppercase;
}

.admin-kicker {
    color: var(--gold);
}

.admin-subtitle {
    color: #dce7f1;
    margin: 8px 0 0;
}

.protected-badge {
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.35);
    border-radius: 999px;
    flex: 0 0 auto;
    font-size: 0.82rem;
    font-weight: 850;
    padding: 8px 12px;
}

.admin-main {
    margin: 0 auto;
    max-width: 1280px;
    padding: 28px 20px 60px;
}

.pilot-warning {
    background: #fff9d8;
    border: 1px solid #dfc44a;
    border-left: 7px solid var(--gold);
    border-radius: 12px;
    color: #493d00;
    padding: 15px 18px;
}

.pilot-warning strong {
    display: block;
    font-size: 1.06rem;
}

.pilot-warning p {
    margin: 4px 0 0;
}

.app-status,
.error-summary {
    border-radius: 10px;
    font-weight: 750;
    margin: 18px 0 0;
    padding: 13px 16px;
}

.app-status {
    background: var(--blue-100);
    border: 1px solid var(--blue-200);
    color: #40576a;
}

.app-status[data-state="success"] {
    background: var(--success-bg);
    border-color: #a8d4bd;
    color: var(--success);
}

.app-status[data-state="error"],
.error-summary {
    background: var(--danger-bg);
    border: 1px solid #d9afaf;
    border-left: 6px solid var(--danger);
    color: #6d2020;
}

.admin-workspace {
    display: grid;
    gap: 22px;
    grid-template-columns: minmax(250px, 0.34fr) minmax(0, 1fr);
    margin-top: 24px;
}

.admin-panel {
    background: var(--surface);
    border: 1px solid var(--blue-200);
    border-radius: 16px;
    box-shadow: 0 8px 24px rgba(15, 36, 56, 0.08);
    min-width: 0;
    padding: 24px;
}

.drafts-panel {
    align-self: start;
    grid-row: span 2;
    position: sticky;
    top: 18px;
}

.form-panel,
.review-panel,
.exclusion-panel {
    grid-column: 2;
}

.panel-heading {
    align-items: start;
    display: flex;
    gap: 18px;
    justify-content: space-between;
}

.panel-heading h2 {
    color: var(--navy-950);
    font-size: clamp(1.45rem, 3vw, 1.85rem);
    line-height: 1.15;
    margin: 0;
}

.panel-heading p:not(.section-kicker),
.panel-help {
    color: var(--muted);
    margin: 8px 0 0;
}

.section-kicker {
    color: var(--navy-700);
}

.step-marker {
    color: #d8e2eb;
    font-size: 3.25rem;
    font-weight: 950;
    letter-spacing: -0.08em;
    line-height: 0.9;
}

.compact-heading {
    align-items: center;
}

.draft-list {
    display: grid;
    gap: 10px;
    margin-top: 16px;
}

.draft-card {
    background: #f8fafc;
    border: 1px solid var(--blue-200);
    border-radius: 11px;
    display: grid;
    gap: 6px;
    padding: 13px;
}

.draft-card strong,
.draft-card span {
    overflow-wrap: anywhere;
}

.draft-card span {
    color: var(--muted);
    font-size: 0.84rem;
}

.draft-card .button {
    margin-top: 4px;
    width: 100%;
}

.empty-note {
    color: var(--muted);
    margin: 0;
}

.form-section {
    border: 0;
    border-top: 1px solid var(--blue-200);
    margin: 24px 0 0;
    min-width: 0;
    padding: 24px 0 0;
}

.form-section > legend {
    color: var(--navy-800);
    font-size: 1.12rem;
    font-weight: 900;
    padding: 0 10px 0 0;
}

.field-help {
    color: var(--muted);
    margin: 7px 0 14px;
}

.fixed-area {
    background: var(--blue-100);
    border: 1px solid var(--blue-300);
    border-left: 6px solid var(--navy-700);
    border-radius: 12px;
    display: grid;
    gap: 3px;
    margin-top: 24px;
    padding: 14px 16px;
}

.fixed-area > span {
    color: var(--muted);
    font-size: 0.76rem;
    font-weight: 900;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.fixed-area > strong {
    color: var(--navy-950);
    font-size: 1.15rem;
}

.fixed-area > small {
    color: var(--muted);
}

.field-grid {
    display: grid;
    gap: 16px;
    margin-top: 16px;
}

.two-columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.form-field {
    display: grid;
    gap: 7px;
    margin-top: 16px;
    min-width: 0;
}

.form-field > span {
    color: #30485f;
    font-size: 0.79rem;
    font-weight: 900;
    letter-spacing: 0.045em;
    text-transform: uppercase;
}

.form-field em {
    font-weight: 700;
    text-transform: none;
}

.form-field small {
    color: #63788a;
    font-size: 0.77rem;
    line-height: 1.35;
}

.form-field input,
.form-field select,
.form-field textarea {
    background: white;
    border: 2px solid var(--blue-300);
    border-radius: 10px;
    color: var(--navy-950);
    min-height: 48px;
    padding: 10px 12px;
    width: 100%;
}

.form-field textarea {
    min-height: 92px;
    resize: vertical;
}

.form-field input[aria-invalid="true"],
.form-field select[aria-invalid="true"],
.form-field textarea[aria-invalid="true"] {
    border-color: var(--danger);
}

.choice-row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
}

.choice-card {
    align-items: center;
    background: #f8fafc;
    border: 1px solid var(--blue-300);
    border-radius: 10px;
    display: flex;
    font-weight: 850;
    gap: 9px;
    min-height: 46px;
    padding: 9px 13px;
}

.choice-card:has(input:checked) {
    background: var(--navy-800);
    border-color: var(--navy-800);
    color: white;
}

.choice-card input,
.check-line input,
.athlete-option input {
    height: 20px;
    margin: 0;
    width: 20px;
}

.compact-choices {
    margin-top: 8px;
}

.check-line {
    align-items: start;
    display: flex;
    font-weight: 750;
    gap: 10px;
    margin-top: 18px;
}

.important-check {
    background: #f7fafc;
    border: 1px solid var(--blue-200);
    border-radius: 10px;
    padding: 13px;
}

.nested-fieldset {
    border: 0;
    margin: 20px 0 0;
    padding: 0;
}

.nested-fieldset legend {
    color: var(--navy-800);
    font-weight: 850;
}

.athlete-choices {
    display: grid;
    gap: 16px;
}

.athlete-group {
    border: 1px solid var(--blue-200);
    border-radius: 11px;
    min-width: 0;
    padding: 13px;
}

.athlete-group h3 {
    color: var(--navy-800);
    font-size: 0.94rem;
    margin: 0 0 10px;
}

.athlete-option-list {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.athlete-option {
    align-items: start;
    background: #f8fafc;
    border-radius: 8px;
    display: flex;
    gap: 9px;
    min-width: 0;
    padding: 9px;
}

.athlete-option span {
    min-width: 0;
    overflow-wrap: anywhere;
}

.athlete-option small {
    color: var(--muted);
    display: block;
    font-size: 0.72rem;
}

.athlete-option.is-blocked {
    background: var(--danger-bg);
    color: #6d2020;
}

.form-actions,
.moderation-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 11px;
    margin-top: 24px;
}

.button {
    border: 2px solid transparent;
    border-radius: 9px;
    font-weight: 900;
    min-height: 44px;
    padding: 9px 15px;
}

.button-primary {
    background: var(--navy-800);
    color: white;
}

.button-secondary {
    background: white;
    border-color: var(--navy-700);
    color: var(--navy-800);
}

.button-danger {
    background: white;
    border-color: var(--danger);
    color: var(--danger);
}

.button:hover:not(:disabled) {
    filter: brightness(0.94);
}

.button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
.skip-link:focus-visible {
    box-shadow: 0 0 0 4px rgba(43, 92, 136, 0.2);
    outline: 3px solid var(--gold);
    outline-offset: 2px;
}

.draft-facts {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin: 22px 0 0;
}

.draft-fact {
    background: var(--blue-100);
    border-radius: 10px;
    min-width: 0;
    padding: 11px;
}

.draft-fact dt {
    color: var(--muted);
    font-size: 0.72rem;
    font-weight: 900;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}

.draft-fact dd {
    font-weight: 850;
    margin: 3px 0 0;
    overflow-wrap: anywhere;
}

.upload-box,
.protected-preview,
.withdrawal-box {
    background: #f8fafc;
    border: 1px solid var(--blue-200);
    border-radius: 13px;
    margin-top: 20px;
    padding: 18px;
}

.upload-box h3,
.protected-preview h3,
.withdrawal-box h3 {
    color: var(--navy-800);
    margin: 0;
}

.upload-box > p,
.protected-preview > p,
.withdrawal-box > p {
    color: var(--muted);
    margin: 6px 0 14px;
}

.withdrawal-box {
    background: var(--danger-bg);
    border-color: #d9afaf;
}

.withdrawal-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 11px;
}

.athlete-exclusion-controls {
    border-top: 1px solid #d9afaf;
    margin-top: 18px;
    padding-top: 2px;
}

.upload-progress {
    display: grid;
    gap: 7px;
    margin-top: 16px;
}

.upload-progress label {
    font-weight: 850;
}

.upload-progress progress {
    accent-color: var(--navy-700);
    height: 20px;
    width: 100%;
}

.upload-progress p {
    color: var(--muted);
    margin: 0;
}

.checksum-result {
    background: var(--success-bg);
    border: 1px solid #a8d4bd;
    border-radius: 9px;
    display: grid;
    gap: 5px;
    margin-top: 15px;
    padding: 12px;
}

.checksum-result code {
    font-size: 0.78rem;
    overflow-wrap: anywhere;
}

.preview-media {
    align-items: center;
    background: var(--navy-950);
    border-radius: 10px;
    display: flex;
    justify-content: center;
    min-height: 180px;
    overflow: hidden;
}

.preview-media img,
.preview-media video {
    display: block;
    max-height: 560px;
    max-width: 100%;
    width: auto;
}

@media (max-width: 860px) {
    .admin-header {
        align-items: flex-start;
        flex-direction: column;
        padding: 20px;
    }

    .admin-workspace {
        grid-template-columns: minmax(0, 1fr);
    }

    .drafts-panel,
    .form-panel,
    .review-panel,
    .exclusion-panel {
        grid-column: 1;
        grid-row: auto;
        position: static;
    }

    .drafts-panel {
        order: 2;
    }

    .form-panel {
        order: 1;
    }

    .exclusion-panel {
        order: 2;
    }

    .review-panel {
        order: 3;
    }
}

@media (max-width: 600px) {
    .admin-main {
        padding: 18px 12px 42px;
    }

    .admin-panel {
        border-radius: 12px;
        padding: 18px 15px;
    }

    .two-columns,
    .athlete-option-list,
    .draft-facts {
        grid-template-columns: minmax(0, 1fr);
    }

    .panel-heading {
        gap: 10px;
    }

    .step-marker {
        font-size: 2.5rem;
    }

    .choice-row,
    .form-actions,
    .moderation-actions {
        align-items: stretch;
        flex-direction: column;
    }

    .choice-card,
    .button {
        width: 100%;
    }
}

@media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
    }
}`;

const ADMIN_CLIENT_SCRIPT = String.raw`(function () {
    'use strict';

    var state = {
        csrfToken: '',
        siteMode: '',
        siteQuery: '',
        catalog: null,
        drafts: [],
        activeDraft: null,
        upload: null,
        selectedFile: null,
        busy: false
    };

    var elements = {};
    var mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    var validSiteModes = new Set(['family', 'everyone']);
    var sha256Pattern = /^[a-f0-9]{64}$/;

    document.addEventListener('DOMContentLoaded', initialize);

    async function initialize() {
        collectElements();

        try {
            state.siteMode = readInheritedSiteMode();
            state.siteQuery = '?site=' + state.siteMode;
            elements.siteAreaLabel.textContent = siteModeLabel(state.siteMode) + ' Gallery';
            bindEvents();
            await refreshSession();
            var initial = await Promise.all([
                api('/api/browser/catalog'),
                api('/api/browser/drafts')
            ]);
            state.catalog = normalizeCatalog(initial[0]);
            state.drafts = normalizeDraftList(initial[1]);
            populateDateChoices();
            populateAthleteExclusionChoices();
            renderDraftList();
            elements.workspace.hidden = false;
            setStatus(
                'The private ' + siteModeLabel(state.siteMode) + ' photo workspace is ready.',
                'success'
            );
        } catch (error) {
            showError(error, 'The protected workspace could not be loaded.');
        }
    }

    function readInheritedSiteMode() {
        var search = window.location.search;
        if (search === '?site=family') {
            return 'family';
        }
        if (search === '?site=everyone') {
            return 'everyone';
        }
        throw new Error(
            'This private Gallery page must be opened from a Gallery area using exactly ' +
            '?site=family or ?site=everyone. No upload area has been accepted.'
        );
    }

    function siteScopedApiPath(path) {
        if (!validSiteModes.has(state.siteMode) || !state.siteQuery) {
            throw new Error('The inherited Gallery area is unavailable. No private request was sent.');
        }
        if (
            typeof path !== 'string' ||
            !path.startsWith('/api/browser/') ||
            path.includes('?') ||
            path.includes('#')
        ) {
            throw new Error('The private request path was not accepted.');
        }
        return path + state.siteQuery;
    }

    function collectElements() {
        elements.workspace = byId('admin-workspace');
        elements.appStatus = byId('app-status');
        elements.errorSummary = byId('error-summary');
        elements.siteAreaLabel = byId('site-area-label');
        elements.refreshDrafts = byId('refresh-drafts');
        elements.draftList = byId('draft-list');
        elements.form = byId('draft-form');
        elements.raceDate = byId('race-date');
        elements.raceChoice = byId('race-choice');
        elements.athleteChoices = byId('athlete-choices');
        elements.guardianWrap = byId('guardian-confirmation');
        elements.guardianApproved = byId('guardian-approved');
        elements.createDraft = byId('create-draft');
        elements.draftWorkspace = byId('draft-workspace');
        elements.reviewSummary = byId('review-summary');
        elements.draftFacts = byId('draft-facts');
        elements.photoFile = byId('photo-file');
        elements.startUpload = byId('start-upload');
        elements.uploadProgressWrap = byId('upload-progress-wrap');
        elements.uploadProgress = byId('upload-progress');
        elements.uploadProgressText = byId('upload-progress-text');
        elements.checksumResult = byId('checksum-result');
        elements.checksumValue = byId('checksum-value');
        elements.protectedPreview = byId('protected-preview');
        elements.previewMedia = byId('preview-media');
        elements.approveDraft = byId('approve-draft');
        elements.returnDraft = byId('return-draft');
        elements.reopenDraft = byId('reopen-draft');
        elements.rejectDraft = byId('reject-draft');
        elements.withdrawalControls = byId('withdrawal-controls');
        elements.editorialWithdrawal = byId('editorial-withdrawal');
        elements.consentWithdrawal = byId('consent-withdrawal');
        elements.athleteExclusionChoice = byId('athlete-exclusion-choice');
        elements.athleteExclusion = byId('athlete-exclusion');
    }

    function bindEvents() {
        elements.refreshDrafts.addEventListener('click', refreshDrafts);
        elements.form.addEventListener('submit', createDraft);
        elements.raceDate.addEventListener('change', onDateChanged);
        elements.raceChoice.addEventListener('change', renderAthleteChoices);
        elements.photoFile.addEventListener('change', onPhotoSelected);
        elements.startUpload.addEventListener('click', startOrResumeUpload);
        elements.approveDraft.addEventListener('click', function () {
            transitionActiveDraft('approved-for-processing');
        });
        elements.returnDraft.addEventListener('click', function () {
            transitionActiveDraft('private-review');
        });
        elements.reopenDraft.addEventListener('click', function () {
            transitionActiveDraft('draft');
        });
        elements.rejectDraft.addEventListener('click', function () {
            transitionActiveDraft('rejected');
        });
        elements.editorialWithdrawal.addEventListener('click', function () {
            initiateActiveDraftWithdrawal('editorial-withdrawal');
        });
        elements.consentWithdrawal.addEventListener('click', function () {
            initiateActiveDraftWithdrawal('consent-withdrawal');
        });
        elements.athleteExclusion.addEventListener('click', initiateSelectedAthleteExclusion);

        document.querySelectorAll('input[name="contains-minors"]').forEach(function (input) {
            input.addEventListener('change', updateGuardianRequirement);
        });
    }

    async function refreshSession() {
        var response = await fetch(siteScopedApiPath('/api/browser/session'), {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json' }
        });
        var body = await readResponseBody(response);
        if (!response.ok || !body || typeof body.csrfToken !== 'string') {
            throw apiError(response.status, body, 'A private browser session could not be created.');
        }
        state.csrfToken = body.csrfToken;
    }

    async function api(path, options) {
        var requestOptions = options || {};
        var method = String(requestOptions.method || 'GET').toUpperCase();
        var headers = new Headers(requestOptions.headers || {});
        var body = requestOptions.body;
        var isMutation = mutationMethods.has(method);
        var refreshed = requestOptions.refreshed === true;

        headers.set('Accept', 'application/json');
        if (isMutation) {
            if (!state.csrfToken) {
                await refreshSession();
            }
            headers.set('X-CSRF-Token', state.csrfToken);
        }

        if (
            body !== undefined &&
            body !== null &&
            !(body instanceof Blob) &&
            !(body instanceof ArrayBuffer) &&
            !ArrayBuffer.isView(body) &&
            typeof body !== 'string'
        ) {
            headers.set('Content-Type', 'application/json');
            body = JSON.stringify(body);
        }

        var response = await fetch(siteScopedApiPath(path), {
            method: method,
            headers: headers,
            body: body,
            credentials: 'same-origin',
            cache: 'no-store'
        });

        if (response.status === 403 && isMutation && !refreshed) {
            await refreshSession();
            return api(path, Object.assign({}, requestOptions, { refreshed: true }));
        }

        var responseBody = await readResponseBody(response);
        if (!response.ok) {
            throw apiError(response.status, responseBody, 'The private request was not accepted.');
        }
        return responseBody;
    }

    async function readResponseBody(response) {
        if (response.status === 204) {
            return null;
        }
        var contentType = response.headers.get('Content-Type') || '';
        if (contentType.toLowerCase().includes('application/json')) {
            try {
                return await response.json();
            } catch (error) {
                return null;
            }
        }
        return null;
    }

    function apiError(status, body, fallback) {
        var message = fallback;
        if (status === 409) {
            message = 'This draft changed in another request. Reload it before trying again.';
        } else if (status === 413) {
            message = 'The photo upload part was larger than the server accepts.';
        } else if (status === 403) {
            message = 'The protected session was not accepted. Sign in again and retry.';
        } else if (body && Array.isArray(body.problems) && body.problems.length) {
            message = body.problems.filter(function (problem) {
                return typeof problem === 'string';
            }).slice(0, 6).join(' ');
        }
        var error = new Error(message);
        error.status = status;
        error.code = body && typeof body.error === 'string' ? body.error : '';
        return error;
    }

    function normalizeCatalog(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('The current Gallery selection catalog is unavailable.');
        }
        if (!value.sites || typeof value.sites !== 'object') {
            throw new Error('The current Gallery selection catalog has no site data.');
        }
        var site = value.sites[state.siteMode];
        if (!site || !Array.isArray(site.races) || !Array.isArray(site.roster)) {
            throw new Error(
                'The ' + siteModeLabel(state.siteMode) + ' Gallery selection catalog is incomplete.'
            );
        }
        if (!Array.isArray(value.blockedAthleteIds)) {
            value.blockedAthleteIds = [];
        }
        return {
            blockedAthleteIds: value.blockedAthleteIds,
            site: {
                races: site.races,
                roster: site.roster,
                results: Array.isArray(site.results) ? site.results : []
            }
        };
    }

    function normalizeDraftList(value) {
        var drafts = Array.isArray(value) ? value : value && value.drafts;
        return Array.isArray(drafts) ? drafts.filter(isObject) : [];
    }

    function populateDateChoices() {
        var modes = selectedSiteModes();
        clearSelect(elements.raceDate, modes.length ? 'Choose a date' : 'Gallery area unavailable');
        clearSelect(elements.raceChoice, 'Choose a date first');
        clearAthletes('Choose an exact race to see the available people.');
        elements.raceChoice.disabled = true;

        if (!modes.length || !state.catalog) {
            elements.raceDate.disabled = true;
            return;
        }

        var dates = unique(selectionRaces(modes).map(function (race) {
            return race.raceDate;
        })).sort().reverse();

        dates.forEach(function (date) {
            appendOption(elements.raceDate, date, formatIsoDate(date));
        });
        elements.raceDate.disabled = dates.length === 0;
        if (!dates.length) {
            replaceFirstOption(elements.raceDate, 'No race dates are available in this area');
        }
    }

    function onDateChanged() {
        clearError();
        clearSelect(elements.raceChoice, 'Choose an event and distance');
        clearAthletes('Choose an exact race to see the available people.');
        var modes = selectedSiteModes();
        var date = elements.raceDate.value;

        if (!date || !modes.length) {
            elements.raceChoice.disabled = true;
            return;
        }

        var races = selectionRaces(modes).filter(function (race) {
            return race.raceDate === date;
        });
        races.sort(function (left, right) {
            return raceLabel(left).localeCompare(raceLabel(right));
        });
        races.forEach(function (race) {
            appendOption(elements.raceChoice, raceKey(race), raceLabel(race));
        });
        elements.raceChoice.disabled = races.length === 0;
    }

    function selectionRaces(modes) {
        if (modes.length !== 1 || modes[0] !== state.siteMode || !state.catalog) {
            return [];
        }
        return deduplicateRaces(state.catalog.site.races.filter(isRace));
    }

    function renderAthleteChoices() {
        clearError();
        var selectedRace = selectedRaceValue();
        var modes = selectedSiteModes();
        if (!selectedRace || !modes.length) {
            clearAthletes('Choose an exact race to see the available people.');
            return;
        }

        var roster = selectionRoster(modes);
        var runnerIdsForRace = new Set(state.catalog.site.results.filter(function (result) {
            return isRace(result) && sameRace(result, selectedRace);
        }).map(function (result) {
            return result.athleteId;
        }));
        var runnerIds = new Set(roster.filter(function (athlete) {
            return runnerIdsForRace.has(athlete.athleteId);
        }).map(function (athlete) {
            return athlete.athleteId;
        }));

        var runners = roster.filter(function (athlete) {
            return runnerIds.has(athlete.athleteId);
        });
        var others = roster.filter(function (athlete) {
            return !runnerIds.has(athlete.athleteId);
        });

        removeChildren(elements.athleteChoices);
        appendAthleteGroup('Ran this race', runners);
        appendAthleteGroup('Other public athletes', others);
    }

    function selectionRoster(modes) {
        if (modes.length !== 1 || modes[0] !== state.siteMode || !state.catalog) {
            return [];
        }
        return deduplicateRoster(state.catalog.site.roster.filter(isRosterEntry));
    }

    function appendAthleteGroup(title, athletes) {
        var section = document.createElement('section');
        section.className = 'athlete-group';
        var heading = document.createElement('h3');
        heading.textContent = title;
        section.appendChild(heading);

        if (!athletes.length) {
            var empty = document.createElement('p');
            empty.className = 'empty-note';
            empty.textContent = 'No athletes are available in this group.';
            section.appendChild(empty);
            elements.athleteChoices.appendChild(section);
            return;
        }

        var list = document.createElement('div');
        list.className = 'athlete-option-list';
        var blocked = new Set(state.catalog.blockedAthleteIds);
        athletes.forEach(function (athlete) {
            var label = document.createElement('label');
            label.className = 'athlete-option';
            var checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.name = 'athlete-id';
            checkbox.value = athlete.athleteId;
            var copy = document.createElement('span');
            copy.textContent = athlete.participant;
            var id = document.createElement('small');
            id.textContent = athlete.athleteId;
            copy.appendChild(id);

            if (blocked.has(athlete.athleteId)) {
                checkbox.disabled = true;
                label.classList.add('is-blocked');
                var reason = document.createElement('small');
                reason.textContent = 'Unavailable because an exclusion is active or pending.';
                copy.appendChild(reason);
            }

            label.appendChild(checkbox);
            label.appendChild(copy);
            list.appendChild(label);
        });
        section.appendChild(list);
        elements.athleteChoices.appendChild(section);
    }

    function updateGuardianRequirement() {
        var containsMinors = selectedRadioValue('contains-minors') === 'yes';
        elements.guardianWrap.hidden = !containsMinors;
        elements.guardianApproved.required = containsMinors;
        if (!containsMinors) {
            elements.guardianApproved.checked = false;
        }
    }

    async function createDraft(event) {
        event.preventDefault();
        clearError();
        updateGuardianRequirement();

        if (!elements.form.checkValidity()) {
            markInvalidControls(elements.form);
            elements.form.reportValidity();
            showError(new Error('Complete the required fields before saving the draft.'));
            return;
        }

        var race = selectedRaceValue();
        var siteModes = selectedSiteModes();
        if (!race || !siteModes.length) {
            showError(new Error('Choose one exact date, event, and distance.'));
            return;
        }

        var body = {
            itemInput: {
                id: byId('item-id').value.trim(),
                type: byId('media-type').value,
                title: byId('item-title').value.trim(),
                caption: byId('item-caption').value.trim(),
                alt: byId('item-alt').value.trim(),
                raceDate: race.raceDate,
                raceEvent: race.raceEvent,
                raceDistance: race.raceDistance,
                featured: byId('item-featured').checked,
                athleteIds: selectedAthleteIds()
            },
            consent: {
                publicUseConfirmed: byId('public-use-confirmed').checked,
                containsMinors: selectedRadioValue('contains-minors') === 'yes',
                guardianApprovalConfirmed: elements.guardianApproved.checked,
                privateEvidenceReference: byId('evidence-reference').value.trim() || null
            }
        };

        await withBusy(elements.createDraft, 'Saving…', async function () {
            var response = await api('/api/browser/drafts', {
                method: 'POST',
                body: body
            });
            state.activeDraft = extractDraft(response);
            if (!state.activeDraft) {
                throw new Error('The server did not return the saved draft.');
            }
            await refreshDrafts(false);
            renderActiveDraft();
            setStatus('The private draft was saved. It has not been published.', 'success');
            elements.draftWorkspace.scrollIntoView({ block: 'start', behavior: preferredScrollBehavior() });
        });
    }

    async function refreshDrafts(announce) {
        clearError();
        await withBusy(elements.refreshDrafts, 'Refreshing…', async function () {
            state.drafts = normalizeDraftList(await api('/api/browser/drafts'));
            renderDraftList();
            if (announce !== false) {
                setStatus('Saved drafts were refreshed.', 'success');
            }
        });
    }

    function renderDraftList() {
        removeChildren(elements.draftList);
        if (!state.drafts.length) {
            var empty = document.createElement('p');
            empty.className = 'empty-note';
            empty.textContent = 'No private drafts yet.';
            elements.draftList.appendChild(empty);
            return;
        }

        state.drafts.forEach(function (draft) {
            var card = document.createElement('article');
            card.className = 'draft-card';
            var title = document.createElement('strong');
            title.textContent = draftTitle(draft);
            var stateText = document.createElement('span');
            stateText.textContent = 'Status: ' + stateLabel(draft.state);
            var race = document.createElement('span');
            race.textContent = draftRaceLabel(draft);
            var button = document.createElement('button');
            button.className = 'button button-secondary';
            button.type = 'button';
            button.textContent = 'Open draft';
            button.addEventListener('click', function () {
                openDraft(draft.draftId || draft.id);
            });
            card.appendChild(title);
            card.appendChild(stateText);
            card.appendChild(race);
            card.appendChild(button);
            elements.draftList.appendChild(card);
        });
    }

    async function openDraft(draftId) {
        if (typeof draftId !== 'string' || !draftId) {
            showError(new Error('The selected draft has no safe identifier.'));
            return;
        }
        clearError();
        try {
            state.activeDraft = extractDraft(await api('/api/browser/drafts/' + encodeURIComponent(draftId)));
            if (!state.activeDraft) {
                throw new Error('The selected draft could not be read.');
            }
            state.selectedFile = null;
            elements.photoFile.value = '';
            state.upload = null;
            renderActiveDraft();
            if (state.activeDraft.state === 'uploading') {
                await loadUploadStatus();
            }
            setStatus('The private draft is open.', 'success');
            elements.draftWorkspace.scrollIntoView({ block: 'start', behavior: preferredScrollBehavior() });
        } catch (error) {
            showError(error, 'The selected draft could not be opened.');
        }
    }

    function renderActiveDraft() {
        var draft = state.activeDraft;
        if (!draft) {
            elements.draftWorkspace.hidden = true;
            return;
        }

        elements.draftWorkspace.hidden = false;
        elements.reviewSummary.textContent = draftTitle(draft) + ' — ' + stateLabel(draft.state) + '.';
        renderDraftFacts(draft);
        renderModerationActions(draft.state);
        renderWithdrawalControls(draft);
        renderChecksum(draft);
        renderPreview(draft);

        var canUpload = mediaTypeOf(draft) === 'photo' &&
            (draft.state === 'draft' || draft.state === 'uploading');
        elements.startUpload.hidden = !canUpload;
        elements.startUpload.textContent = draft.state === 'uploading'
            ? 'Resume private photo upload'
            : 'Start private photo upload';
        elements.uploadProgressWrap.hidden = !canUpload && draft.state !== 'private-review';
    }

    function renderDraftFacts(draft) {
        removeChildren(elements.draftFacts);
        appendFact('Status', stateLabel(draft.state));
        appendFact('Area', siteModeLabel(state.siteMode) + ' Gallery');
        appendFact('Race', draftRaceLabel(draft));
        appendFact('Media', 'Photo');
        appendFact('People tagged', String(athleteIdsOf(draft).length));
        appendFact('Version', String(numberOrZero(draft.stateVersion)));
    }

    function appendFact(term, description) {
        var wrap = document.createElement('div');
        wrap.className = 'draft-fact';
        var dt = document.createElement('dt');
        dt.textContent = term;
        var dd = document.createElement('dd');
        dd.textContent = description;
        wrap.appendChild(dt);
        wrap.appendChild(dd);
        elements.draftFacts.appendChild(wrap);
    }

    function renderModerationActions(draftState) {
        elements.approveDraft.hidden = draftState !== 'private-review';
        elements.rejectDraft.hidden = draftState !== 'private-review';
        elements.returnDraft.hidden = draftState !== 'approved-for-processing';
        elements.reopenDraft.hidden = draftState !== 'rejected';
    }

    function renderWithdrawalControls(draft) {
        var withdrawn = draft.state === 'withdrawn';
        var pending = draft.state === 'withdrawal-pending';
        elements.withdrawalControls.hidden = withdrawn;
        elements.editorialWithdrawal.hidden = pending || withdrawn;
        elements.consentWithdrawal.hidden = withdrawn;
    }

    function populateAthleteExclusionChoices() {
        clearSelect(elements.athleteExclusionChoice, 'Choose a current public athlete');
        var blocked = new Set(state.catalog ? state.catalog.blockedAthleteIds : []);
        var eligible = selectionRoster(selectedSiteModes()).filter(function (entry) {
            return !blocked.has(entry.athleteId);
        });
        eligible.forEach(function (entry) {
            appendOption(
                elements.athleteExclusionChoice,
                entry.athleteId,
                entry.participant + ' — ' + entry.athleteId
            );
        });
        if (!eligible.length) {
            replaceFirstOption(
                elements.athleteExclusionChoice,
                'No current public athletes are available'
            );
        }
        elements.athleteExclusionChoice.disabled = !eligible.length;
        elements.athleteExclusion.disabled = !eligible.length;
    }

    function renderChecksum(draft) {
        var checksum = draft.originalSha256 || draft.original_sha256 || draft.sha256 || '';
        if (sha256Pattern.test(checksum)) {
            elements.checksumValue.textContent = checksum;
            elements.checksumResult.hidden = false;
        } else {
            elements.checksumValue.textContent = '';
            elements.checksumResult.hidden = true;
        }
    }

    function renderPreview(draft) {
        removeChildren(elements.previewMedia);
        var previewStates = new Set([
            'private-review',
            'approved-for-processing'
        ]);
        if (!previewStates.has(draft.state)) {
            elements.protectedPreview.hidden = true;
            return;
        }

        var draftId = draft.draftId || draft.id;
        if (typeof draftId !== 'string' || !draftId) {
            elements.protectedPreview.hidden = true;
            return;
        }

        var source = siteScopedApiPath(
            '/api/browser/drafts/' + encodeURIComponent(draftId) + '/original'
        );
        var media;
        if (mediaTypeOf(draft) === 'video') {
            media = document.createElement('video');
            media.controls = true;
            media.preload = 'metadata';
            media.setAttribute('aria-label', altTextOf(draft) || 'Protected video preview');
        } else {
            media = document.createElement('img');
            media.alt = altTextOf(draft) || 'Protected private photo preview';
        }
        media.src = source;
        elements.previewMedia.appendChild(media);
        elements.protectedPreview.hidden = false;
    }

    async function startOrResumeUpload() {
        var draft = state.activeDraft;
        if (!draft || !['draft', 'uploading'].includes(draft.state)) {
            showError(new Error('This draft is not ready for a private photo upload.'));
            return;
        }

        clearError();
        await withBusy(elements.startUpload, 'Preparing…', async function () {
            if (!state.selectedFile) {
                throw new Error('Choose the JPEG or PNG photograph to upload.');
            }

            var file = validateSelectedPhoto(state.selectedFile);
            setUploadProgress(0, 'Hashing the complete photo before upload…');
            var declaredSha256 = await sha256Hex(await file.arrayBuffer());

            if (draft.state === 'draft') {
                var initiation = await api(draftPath(draft) + '/upload', {
                    method: 'POST',
                    body: {
                        expectedStateVersion: numberOrZero(draft.stateVersion),
                        fileExtension: photoExtension(file.name),
                        declaredMimeType: file.type,
                        byteLength: file.size,
                        declaredSha256: declaredSha256,
                        idempotencyKey: randomToken('upload')
                    }
                });
                applyDraftResponse(initiation);
                state.upload = extractUpload(initiation);
                await reloadActiveDraft();
            } else {
                await loadUploadStatus();
            }

            if (!state.upload) {
                await loadUploadStatus();
            }
            await uploadMissingParts();
            await completeUpload();
        });
    }

    async function loadUploadStatus() {
        if (!state.activeDraft) {
            return;
        }
        var response = await api(draftPath(state.activeDraft) + '/upload');
        applyDraftResponse(response);
        state.upload = extractUpload(response);
        renderUploadStatus();
    }

    function extractUpload(value) {
        var candidate = value && value.upload ? value.upload : value;
        if (!candidate || typeof candidate !== 'object') {
            return null;
        }
        var partSize = Number(candidate.partSize);
        var partCount = Number(candidate.partCount);
        if (!Number.isSafeInteger(partSize) || partSize <= 0) {
            return null;
        }
        if (!Number.isSafeInteger(partCount) || partCount <= 0) {
            return null;
        }
        var uploadedParts = Array.isArray(candidate.uploadedParts) ? candidate.uploadedParts : [];
        return {
            partSize: partSize,
            partCount: partCount,
            uploadedParts: uploadedParts
        };
    }

    async function uploadMissingParts() {
        var upload = state.upload;
        var file = state.selectedFile;
        if (!upload || !file) {
            throw new Error('The resumable upload information is incomplete.');
        }

        var uploaded = uploadedPartNumbers(upload.uploadedParts);
        for (var partNumber = 1; partNumber <= upload.partCount; partNumber += 1) {
            if (uploaded.has(partNumber)) {
                updateUploadedProgress(uploaded);
                continue;
            }

            var start = (partNumber - 1) * upload.partSize;
            var end = Math.min(start + upload.partSize, file.size);
            var chunk = file.slice(start, end, 'application/octet-stream');
            if (chunk.size <= 0) {
                throw new Error('The server requested an invalid private photo upload part.');
            }
            var chunkHash = await sha256Hex(await chunk.arrayBuffer());
            setUploadProgress(
                Math.floor((start / file.size) * 100),
                'Uploading photo part ' + partNumber + ' of ' + upload.partCount + '…'
            );

            var partResponse = await api(
                draftPath(state.activeDraft) + '/upload-parts/' + partNumber,
                {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-Chunk-SHA256': chunkHash
                    },
                    body: chunk
                }
            );
            upload.uploadedParts.push(partResponse && partResponse.part ? partResponse.part : {
                partNumber: partNumber,
                byteCount: chunk.size,
                sha256: chunkHash
            });
            uploaded.add(partNumber);
            updateUploadedProgress(uploaded);
        }
    }

    function updateUploadedProgress(uploaded) {
        var upload = state.upload;
        var file = state.selectedFile;
        var uploadedBytes = 0;
        uploaded.forEach(function (partNumber) {
            var start = (partNumber - 1) * upload.partSize;
            uploadedBytes += Math.max(0, Math.min(upload.partSize, file.size - start));
        });
        var percentage = file.size ? Math.min(100, Math.round((uploadedBytes / file.size) * 100)) : 0;
        setUploadProgress(
            percentage,
            uploaded.size + ' of ' + upload.partCount + ' photo parts uploaded (' + percentage + '%).'
        );
    }

    function renderUploadStatus() {
        if (!state.upload) {
            return;
        }
        elements.uploadProgressWrap.hidden = false;
        var uploaded = uploadedPartNumbers(state.upload.uploadedParts);
        var percentage = Math.round((uploaded.size / state.upload.partCount) * 100);
        setUploadProgress(
            percentage,
            uploaded.size + ' of ' + state.upload.partCount + ' photo parts are safely stored.'
        );
    }

    async function completeUpload() {
        setUploadProgress(100, 'Verifying the complete photo, type, and checksum…');
        var response = await api(draftPath(state.activeDraft) + '/upload-completion', {
            method: 'POST',
            body: {
                expectedStateVersion: numberOrZero(state.activeDraft.stateVersion),
                idempotencyKey: randomToken('complete')
            }
        });
        applyDraftResponse(response);
        if (!state.activeDraft || state.activeDraft.state !== 'private-review') {
            await reloadActiveDraft();
        }
        renderActiveDraft();
        await refreshDrafts(false);
        setUploadProgress(100, 'Private photo upload complete and verified.');
        setStatus('The private original is ready for review.', 'success');
    }

    async function transitionActiveDraft(toState) {
        if (!state.activeDraft) {
            return;
        }
        clearError();
        var button = transitionButton(toState);
        await withBusy(button, 'Saving…', async function () {
            var response = await api(draftPath(state.activeDraft) + '/transitions', {
                method: 'POST',
                body: {
                    toState: toState,
                    expectedStateVersion: numberOrZero(state.activeDraft.stateVersion),
                    idempotencyKey: randomToken('transition')
                }
            });
            applyDraftResponse(response);
            if (!state.activeDraft || state.activeDraft.state !== toState) {
                await reloadActiveDraft();
            }
            renderActiveDraft();
            await refreshDrafts(false);
            setStatus('Draft status changed to ' + stateLabel(toState) + '.', 'success');
        });
    }

    async function initiateActiveDraftWithdrawal(kind) {
        if (!state.activeDraft) {
            return;
        }
        var consentWithdrawal = kind === 'consent-withdrawal';
        var confirmed = window.confirm(consentWithdrawal
            ? 'Record that consent has been withdrawn and start removal of this item? ' +
                'This is one-way. Final deletion still requires the protected verification steps.'
            : 'Start removal of this item from the Gallery? ' +
                'It will stay withdrawal pending until the protected verification steps finish.');
        if (!confirmed) {
            return;
        }

        clearError();
        var button = consentWithdrawal
            ? elements.consentWithdrawal
            : elements.editorialWithdrawal;
        await withBusy(button, 'Starting removal…', async function () {
            await api(draftPath(state.activeDraft) + '/' + kind, {
                method: 'POST',
                body: {
                    expectedStateVersion: numberOrZero(state.activeDraft.stateVersion),
                    idempotencyKey: randomToken('withdrawal')
                }
            });
            await reloadActiveDraft();
            renderActiveDraft();
            await refreshDrafts(false);
            setStatus(
                consentWithdrawal
                    ? 'Consent-withdrawal intent is recorded and protected removal is pending.'
                    : 'Protected Gallery removal has started and is pending verification.',
                'success'
            );
        });
    }

    async function initiateSelectedAthleteExclusion() {
        var athleteId = elements.athleteExclusionChoice.value;
        var currentPublicIds = new Set(selectionRoster(selectedSiteModes()).map(function (entry) {
            return entry.athleteId;
        }));
        if (!athleteId || !currentPublicIds.has(athleteId)) {
            showError(new Error('Choose one current public athlete.'));
            return;
        }
        var selectedOption = elements.athleteExclusionChoice.selectedOptions[0];
        var label = selectedOption ? selectedOption.textContent : athleteId;
        if (!window.confirm(
            'Start athlete-wide exclusion for ' + label + '? ' +
            'Every Gallery item carrying this tag will be removed as a whole. ' +
            'Final deletion still requires the protected verification steps.'
        )) {
            return;
        }

        clearError();
        await withBusy(elements.athleteExclusion, 'Starting exclusion…', async function () {
            await api('/api/browser/athlete-exclusions', {
                method: 'POST',
                body: {
                    athleteId: athleteId,
                    idempotencyKey: randomToken('exclusion')
                }
            });
            state.catalog.blockedAthleteIds = unique(
                state.catalog.blockedAthleteIds.concat([athleteId])
            );
            populateAthleteExclusionChoices();
            if (state.activeDraft) {
                await reloadActiveDraft();
                renderActiveDraft();
            }
            await refreshDrafts(false);
            setStatus(
                'The athlete-wide exclusion is pending. Every matching tagged item is blocked.',
                'success'
            );
        });
    }

    function transitionButton(toState) {
        if (toState === 'approved-for-processing') {
            return elements.approveDraft;
        }
        if (toState === 'private-review') {
            return elements.returnDraft;
        }
        if (toState === 'draft') {
            return elements.reopenDraft;
        }
        return elements.rejectDraft;
    }

    async function reloadActiveDraft() {
        var draftId = state.activeDraft && (state.activeDraft.draftId || state.activeDraft.id);
        if (!draftId) {
            throw new Error('The current draft identifier is unavailable.');
        }
        state.activeDraft = extractDraft(await api('/api/browser/drafts/' + encodeURIComponent(draftId)));
        if (!state.activeDraft) {
            throw new Error('The updated draft could not be read.');
        }
    }

    function applyDraftResponse(response) {
        var draft = extractDraft(response);
        if (draft) {
            var currentId = state.activeDraft && (state.activeDraft.draftId || state.activeDraft.id);
            var nextId = draft.draftId || draft.id;
            state.activeDraft = currentId && nextId === currentId
                ? Object.assign({}, state.activeDraft, draft)
                : draft;
        }
    }

    function extractDraft(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return null;
        }
        if (isObject(value.draft)) {
            return value.draft;
        }
        if (typeof value.draftId === 'string' || typeof value.id === 'string') {
            return value;
        }
        return null;
    }

    function onPhotoSelected() {
        clearError();
        try {
            state.selectedFile = validateSelectedPhoto(elements.photoFile.files[0]);
            setStatus('The photo is selected locally. It has not been uploaded.', 'success');
        } catch (error) {
            state.selectedFile = null;
            elements.photoFile.value = '';
            showError(error);
        }
    }

    function validateSelectedPhoto(file) {
        if (!(file instanceof File)) {
            throw new Error('Choose one JPEG or PNG photograph.');
        }
        var extension = photoExtension(file.name);
        var expectedType = extension === 'png' ? 'image/png' : 'image/jpeg';
        if (file.type !== expectedType) {
            throw new Error('The selected photo extension and browser media type do not agree.');
        }
        if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 25 * 1024 * 1024) {
            throw new Error('The selected photo must be between 1 byte and 25 MiB.');
        }
        return file;
    }

    function photoExtension(fileName) {
        var match = /\.([A-Za-z0-9]+)$/.exec(String(fileName || ''));
        var extension = match ? match[1].toLowerCase() : '';
        if (!['jpg', 'jpeg', 'png'].includes(extension)) {
            throw new Error('Choose a .jpg, .jpeg, or .png photograph.');
        }
        return extension;
    }

    function setUploadProgress(value, message) {
        var percentage = Math.max(0, Math.min(100, Number(value) || 0));
        elements.uploadProgressWrap.hidden = false;
        elements.uploadProgress.value = percentage;
        elements.uploadProgress.textContent = percentage + '%';
        elements.uploadProgressText.textContent = message;
    }

    function selectedSiteModes() {
        return validSiteModes.has(state.siteMode) ? [state.siteMode] : [];
    }

    function selectedRaceValue() {
        var key = elements.raceChoice.value;
        if (!key) {
            return null;
        }
        return selectionRaces(selectedSiteModes()).find(function (race) {
            return raceKey(race) === key;
        }) || null;
    }

    function selectedAthleteIds() {
        return Array.from(document.querySelectorAll('input[name="athlete-id"]:checked')).map(function (input) {
            return input.value;
        });
    }

    function selectedRadioValue(name) {
        var selected = document.querySelector('input[name="' + name + '"]:checked');
        return selected ? selected.value : '';
    }

    function draftPath(draft) {
        var draftId = draft && (draft.draftId || draft.id);
        if (typeof draftId !== 'string' || !draftId) {
            throw new Error('The current draft identifier is unavailable.');
        }
        return '/api/browser/drafts/' + encodeURIComponent(draftId);
    }

    function draftTitle(draft) {
        var item = isObject(draft.itemInput) ? draft.itemInput : draft;
        return textValue(item.title) || textValue(item.publicItemId) || textValue(item.id) || 'Untitled private draft';
    }

    function draftRaceLabel(draft) {
        var item = isObject(draft.itemInput) ? draft.itemInput : draft;
        var event = textValue(item.raceEvent || item.race_event);
        var distance = textValue(item.raceDistance || item.race_distance);
        var date = textValue(item.raceDate || item.race_date);
        var parts = [event, distance, formatIsoDate(date)].filter(Boolean);
        return parts.length ? parts.join(' — ') : 'Race not available';
    }

    function mediaTypeOf(draft) {
        var item = isObject(draft.itemInput) ? draft.itemInput : draft;
        return item.type === 'video' || item.mediaType === 'video' || item.media_type === 'video'
            ? 'video'
            : 'photo';
    }

    function altTextOf(draft) {
        var item = isObject(draft.itemInput) ? draft.itemInput : draft;
        return textValue(item.alt || item.altText || item.alt_text);
    }

    function athleteIdsOf(draft) {
        var item = isObject(draft.itemInput) ? draft.itemInput : draft;
        if (Array.isArray(item.athleteIds)) {
            return item.athleteIds;
        }
        if (Array.isArray(item.athlete_ids)) {
            return item.athlete_ids;
        }
        return [];
    }

    function stateLabel(value) {
        var labels = {
            draft: 'Draft',
            uploading: 'Uploading',
            'private-review': 'Private review',
            'approved-for-processing': 'Approved for processing',
            processing: 'Processing',
            'candidate-public': 'Candidate for public review',
            'pr-open': 'Pull Request open',
            published: 'Published',
            rejected: 'Rejected',
            'withdrawal-pending': 'Withdrawal pending',
            withdrawn: 'Withdrawn',
            'processing-failed': 'Processing failed'
        };
        return labels[value] || 'Unknown';
    }

    function siteModeLabel(value) {
        return value === 'family' ? 'Family' : value === 'everyone' ? 'Everyone' : 'Unknown';
    }

    function raceKey(race) {
        return [race.raceDate, race.raceEvent, race.raceDistance].join('\u001f');
    }

    function sameRace(left, right) {
        return raceKey(left) === raceKey(right);
    }

    function raceLabel(race) {
        return race.raceEvent + ' — ' + race.raceDistance;
    }

    function isRace(value) {
        return isObject(value) &&
            typeof value.raceDate === 'string' &&
            typeof value.raceEvent === 'string' &&
            typeof value.raceDistance === 'string';
    }

    function isRosterEntry(value) {
        return isObject(value) &&
            typeof value.athleteId === 'string' &&
            typeof value.participant === 'string';
    }

    function deduplicateRaces(races) {
        var seen = new Set();
        return races.filter(function (race) {
            var key = raceKey(race);
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    function deduplicateRoster(roster) {
        var seen = new Set();
        return roster.filter(function (athlete) {
            if (seen.has(athlete.athleteId)) {
                return false;
            }
            seen.add(athlete.athleteId);
            return true;
        });
    }

    function uploadedPartNumbers(parts) {
        var numbers = new Set();
        (Array.isArray(parts) ? parts : []).forEach(function (part) {
            var value = typeof part === 'number' ? part : part && part.partNumber;
            if (Number.isSafeInteger(value) && value > 0) {
                numbers.add(value);
            }
        });
        return numbers;
    }

    async function sha256Hex(bytes) {
        var digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map(function (byte) {
            return byte.toString(16).padStart(2, '0');
        }).join('');
    }

    function randomToken(prefix) {
        var bytes = new Uint8Array(18);
        crypto.getRandomValues(bytes);
        var binary = '';
        bytes.forEach(function (byte) {
            binary += String.fromCharCode(byte);
        });
        return prefix + '-' + btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    async function withBusy(button, busyLabel, work) {
        if (state.busy) {
            return;
        }
        state.busy = true;
        var originalLabel = button ? button.textContent : '';
        if (button) {
            button.disabled = true;
            button.textContent = busyLabel;
        }
        try {
            await work();
        } catch (error) {
            showError(error);
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = originalLabel;
            }
            state.busy = false;
        }
    }

    function showError(error, fallback) {
        var message = error && typeof error.message === 'string' && error.message.trim()
            ? error.message.trim()
            : fallback || 'The private operation could not be completed.';
        elements.errorSummary.textContent = message;
        elements.errorSummary.hidden = false;
        elements.errorSummary.focus();
        setStatus('The last operation needs attention.', 'error');
    }

    function clearError() {
        elements.errorSummary.textContent = '';
        elements.errorSummary.hidden = true;
        elements.form.querySelectorAll('[aria-invalid="true"]').forEach(function (control) {
            control.removeAttribute('aria-invalid');
        });
    }

    function setStatus(message, status) {
        elements.appStatus.textContent = message;
        elements.appStatus.dataset.state = status || '';
    }

    function markInvalidControls(form) {
        form.querySelectorAll('input, select, textarea').forEach(function (control) {
            if (!control.checkValidity()) {
                control.setAttribute('aria-invalid', 'true');
            } else {
                control.removeAttribute('aria-invalid');
            }
        });
    }

    function clearAthletes(message) {
        removeChildren(elements.athleteChoices);
        var note = document.createElement('p');
        note.className = 'empty-note';
        note.textContent = message;
        elements.athleteChoices.appendChild(note);
    }

    function clearSelect(select, label) {
        removeChildren(select);
        appendOption(select, '', label);
        select.value = '';
    }

    function replaceFirstOption(select, label) {
        if (select.options.length) {
            select.options[0].textContent = label;
        }
    }

    function appendOption(select, value, label) {
        var option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    }

    function formatIsoDate(value) {
        if (typeof value !== 'string') {
            return '';
        }
        var match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return match ? match[3] + '/' + match[2] + '/' + match[1] : value;
    }

    function preferredScrollBehavior() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    }

    function delay(milliseconds) {
        return new Promise(function (resolve) {
            window.setTimeout(resolve, milliseconds);
        });
    }

    function numberOrZero(value) {
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }

    function unique(values) {
        return Array.from(new Set(values.filter(function (value) {
            return typeof value === 'string' && value;
        })));
    }

    function isObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function textValue(value) {
        return typeof value === 'string' ? value : '';
    }

    function removeChildren(element) {
        while (element.firstChild) {
            element.removeChild(element.firstChild);
        }
    }

    function byId(id) {
        return document.getElementById(id);
    }
})();`;

export function adminShellDocument() {
    return ADMIN_DOCUMENT;
}

export function adminStylesheet() {
    return ADMIN_STYLESHEET;
}

export function adminClientScript() {
    return ADMIN_CLIENT_SCRIPT;
}
