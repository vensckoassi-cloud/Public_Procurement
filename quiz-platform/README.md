# Quiz & Exam Platform: auto-graded, cheating-resistant, e-mails feedback

You write the questions in a Google Sheet and share one link with your students. They identify themselves (name and verified e-mail) and sit the exam in a locked-down full-screen page. Grading happens **on the server**, and your dashboard shows grades, statistics, item analysis and integrity flags. Each student gets their feedback by e-mail at the address they entered.

There is no server to rent and nothing to install. The backend is a free Google Apps Script attached to a Google Sheet.

```
 Students ──► student/quiz.html ──HTTPS/JSON──► Apps Script web app ──► Google Sheet
                                                   │  grades, stores,       (Quizzes, Questions,
 You ─────► teacher/dashboard.html ──────────────► │  e-mails feedback       Roster, Sessions,
            (admin key)                            ▼                        Submissions)
                                              Gmail (MailApp)
```

| Folder | What it is |
|---|---|
| `apps-script/Code.gs` | The backend: API, grading, anti-cheating checks and e-mails. Paste it into Apps Script. |
| `apps-script/appsscript.json` | Apps Script manifest (scopes, web-app settings). |
| `student/quiz.html` | The page you share with students. It never contains the answers. |
| `teacher/dashboard.html` | Your grade dashboard. Open it locally or host it privately. |
| `dev/` | Local preview server that runs the real `Code.gs` against an in-memory sheet. |
| `tests/` | Backend tests (15) and a browser end-to-end test. |

---

## 1. One-time setup (about 10 minutes)

1. **Create a Google Sheet** (e.g. *"ECON 301 – Assessments"*) with the Google account that should send the feedback e-mails.
2. Open **Extensions → Apps Script**. Delete the sample code and paste the whole of `apps-script/Code.gs`.
   - Optional: in **Project Settings**, tick *Show "appsscript.json"* and replace it with ours. Set `"timeZone"` to your zone (e.g. `"Europe/Paris"`, `"Africa/Lagos"`). Opening and closing times are read in that zone.
   - Edit `CONFIG.COURSE_NAME` at the top of `Code.gs`. It becomes the e-mail sender name.
3. In the editor, select the function **`setup`** and click **Run**. Accept the permissions (Sheets, sending e-mail, triggers). This:
   - creates the five tabs with their headers,
   - adds a demo quiz (`DEMO-MACRO`, with NK/RBC questions),
   - generates your **admin key** (shown in the execution log and in the sheet's *Quiz Platform* menu),
   - installs an hourly trigger that releases "after close" feedback.
4. **Deploy → New deployment → type: Web app**
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
   - Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
5. Open `student/quiz.html` in a text editor and paste that URL into
   `var DEFAULT_API_URL = '…';`
6. **Put `quiz.html` online** so students can open it with a link. Any static host works:
   - GitHub Pages: put `quiz.html` in a public repo, then Settings → Pages.
   - Netlify Drop (drag and drop the file), Google Sites, or your university web space.
   - You can also e-mail the file as an attachment, but a link is easier to update.
7. Open `teacher/dashboard.html` in your browser (double-clicking the file works). Click **Connection**, then paste the web-app URL, your admin key, and the public address of `quiz.html`.

> **After editing `Code.gs`** you must publish a new version: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

The link you give students looks like this (the dashboard's **Copy link** button builds it for you):
```
https://your-site/quiz.html?quiz=DEMO-MACRO
```

---

## 2. Writing an assessment

### `Quizzes` tab: one row per quiz or exam

| Column | Example | Meaning |
|---|---|---|
| `quiz_id` | `MIDTERM-1` | Short id used in the link. |
| `title` | `Midterm – DSGE models` | Shown to students and in e-mails. |
| `instructions` | `Calculators allowed…` | Shown before the start. LaTeX allowed. |
| `access_code` | `K7Q2` | Password you announce in the room. Leave empty for none. |
| `duration_min` | `60` | Time limit, enforced by the server. |
| `open_at` / `close_at` | `2026-12-03 09:00` | Exam window. The timer is capped at `close_at`. |
| `questions_per_student` | `20` | Draw a random subset from the pool (0 = all). |
| `shuffle_questions` / `shuffle_options` | `TRUE` | Each student gets a different order. |
| `navigation` | `free` or `forward_only` | `forward_only` means no going back. |
| `max_violations` | `3` | Auto-submit after this many violations (0 = never auto-submit, just log). |
| `pass_mark_pct` | `50` | Pass/fail threshold. |
| `feedback_mode` | `detailed` / `score` / `none` | `detailed` = per question, with correct answer and explanation. |
| `feedback_release` | `immediate` / `after_close` / `manual` | `after_close` stops early finishers leaking answers. `manual` = you click *Send* in the dashboard. |
| `allowed_domain` | `univ-lome.tg` | Only accept these e-mail domains (comma-separated). |
| `require_roster` | `TRUE` | Only students listed in the `Roster` tab can sit. |
| `require_email_code` | `TRUE` | Students must enter a 6-digit code e-mailed to them (proves the address is theirs). |
| `active` | `TRUE` | Set to `FALSE` to hide the quiz. |

### `Questions` tab: one row per question

| Column | Meaning |
|---|---|
| `quiz_id` | Which quiz the question belongs to. |
| `q_id` | Unique id inside the quiz (`Q1`, `Q2`, …). Don't change it after students have sat the quiz. |
| `type` | `mcq`, `multi`, `tf`, `numeric`, `short`, `essay` (see below). |
| `text` | The question. LaTeX between `$…$` (inline) or `$$…$$` (display), e.g. `$\pi_t = \beta E_t\pi_{t+1} + \kappa \tilde y_t$`. |
| `options` | For `mcq` / `multi`: options separated by `\|`. |
| `answer` | See the table below. |
| `points` | Marks for the question (default 1). |
| `tolerance` | For `numeric`: absolute (`0.01`) or relative (`1%`). Empty = exact. |
| `explanation` | Shown in the detailed feedback e-mail. |

| Type | `answer` column | Grading |
|---|---|---|
| `mcq` | Letter of the correct option: `B` | All or nothing |
| `multi` | Letters: `A,C` | Partial credit = (right ticks − wrong ticks) / number correct, never below 0 |
| `tf` | `TRUE` / `FALSE` | All or nothing |
| `numeric` | `9.40` | Within `tolerance`. Students may type `9,40` or `9.40`. |
| `short` | Accepted answers separated by `\|`: `jump\|forward-looking` | Ignores case, accents, extra spaces and trailing full stops |
| `essay` | Optional model answer (shown to you only) | You grade it in the dashboard |

Answer letters refer to the order in the `options` cell. Shuffling is handled for you.
Numeric answers: a single `.` or `,` is always read as the decimal mark, so ask students not to use thousands separators.

### `Roster` tab (optional)
`quiz_id` (empty or `*` = all quizzes), `email`, `name`, `student_id`. When `require_roster` is on, the roster's name and ID are recorded, not whatever the student typed.

---

## 3. Anti-cheating measures

**Enforced on the server** (a student cannot bypass these by tampering with the page):
- **Answers never leave the server.** The page receives only the question text and options; grading happens in Apps Script.
- **Verified identity.** A 6-digit code is e-mailed to the address the student entered (5 tries, expires in 10 min, rate-limited). Optional domain whitelist and class roster.
- **One attempt per e-mail per quiz.** Only you can allow a retake (dashboard → *Void attempt*).
- **Access code and exam window** (open/close times).
- **Server-side clock.** Reloading, closing the tab or changing the computer's clock does not pause or reset the timer. Re-entering resumes the *same* session (same questions, same deadline) and counts as a violation. A change of device or browser is flagged.
- **Late submissions:** after the deadline plus 90 s of grace, whatever the browser sends is ignored and the last answers autosaved *before* the deadline are graded.
- **Individual papers:** random question order, random option order and an optional random subset from a larger pool.
- **Delayed feedback** (`after_close`), so correct answers can't circulate while others are still sitting.
- **Timing analytics:** a submission averaging under 10 s per question is flagged `too fast`.

**Enforced in the browser** (deterrents, all logged to the server with timestamps):
- Mandatory **full screen**. Leaving it blurs the exam and records a violation.
- **Tab or app switching and minimising** are detected (page visibility and window focus) and counted.
- **Auto-submit** when the violation limit is reached.
- Copy, cut, paste, right-click, text selection, drag-and-drop, printing (also blocked via CSS), view-source, devtools and save shortcuts, and PrintScreen are blocked and logged as minor events.
- Possible open devtools are detected heuristically (logged, not counted).
- A **watermark** with the student's name, e-mail and ID is tiled across the screen, so a leaked photo or screenshot shows who took it.
- A warning appears when someone tries to leave the page; answers are autosaved and backed up on the device in case of a crash.

Counted violations: leaving the tab, leaving the window, leaving full screen, reloading. Minor events are shown in the dashboard log but don't trigger auto-submit. Edit `CONFIG.COUNTED_VIOLATIONS` to change this.

**Limits.** No web page can stop a student from reading notes or using a second device such as a phone. For high-stakes exams, combine this with invigilation in the room, or with a lockdown browser such as Safe Exam Browser. The integrity log and flags show you who to look at more closely. They are evidence, not proof.

---

## 4. The dashboard

- **Overview:** every quiz with its status, number of submissions, students in progress, mean score and a *Copy link* button.
- **Per quiz:**
  - summary tiles: submitted, in progress, mean, median, standard deviation, min–max, pass rate, flagged, needs grading;
  - a histogram of scores with the pass mark;
  - a results table you can sort, search and filter (*flagged only*, *needs grading*);
  - **item analysis:** facility (average share of points earned) and discrimination (correlation between the item score and the rest of the test; below 0.20 suggests a weak or ambiguous item);
  - a live view of students currently sitting, with how many questions each has answered and their violations.
- **Student detail:** each answer next to the expected one; override points or grade essays and add comments (included in the e-mail); the integrity timeline; resend feedback; void an attempt to allow a retake.
- **Export CSV** gives one row per student with a points column per question, ready for R or pandas:
  ```r
  d <- read.csv("MIDTERM-1_results_2026-12-03.csv"); psych::alpha(d[grep("^pts_", names(d))])
  ```
  ```python
  d = pd.read_csv("MIDTERM-1_results_2026-12-03.csv"); d.filter(like="pts_").corr()
  ```
- *Live refresh* updates the view every 20 s while an exam is running.

## 5. E-mail limits
Apps Script's `MailApp` can send about **100 e-mails/day from a free Gmail account** and about **1,500/day from Google Workspace** (most university accounts). Each student uses one e-mail for the verification code and one for feedback. For large classes, use a Workspace account, or turn off `require_email_code` and rely on the roster with a domain restriction. The dashboard shows how many e-mails you have left today. Failed sends are marked `FAILED` and can be resent.

## 6. Try it locally before going live
Requires Node 18+:
```bash
cd quiz-platform
node dev/server.js        # prints the student link, the dashboard link and the admin key
```
- Open the student link. The access code for the demo is `DSGE2026`. The e-mail verification code and the feedback e-mails are printed in the terminal instead of being sent.
- Data is kept in memory only.

Run the tests:
```bash
npm test                  # 15 backend tests: grading, access rules, violations, late answers, e-mail
npm run e2e               # real browser: register → exam → violation → submit → dashboard → e-mail
```

## 7. Troubleshooting
- **"This page is not connected to a grading server yet"**: set `DEFAULT_API_URL` in `quiz.html`, or add `&api=<web-app-url>` to the link.
- **Changes to `Code.gs` have no effect**: deploy a **new version** (see the note in step 1).
- **Times are off by some hours**: set the `timeZone` in `appsscript.json` and the Sheet's own time zone (File → Settings) to your zone.
- **The dashboard says "Invalid admin key"**: use *Quiz Platform → Show admin key* in the Sheet. *Rotate admin key* invalidates old copies.
- **A student lost their connection**: their answers are autosaved. When they reopen the link and verify again, they continue where they left off, with the clock still running.
