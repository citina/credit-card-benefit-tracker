# Setup — Credit Card Benefit Tracker

A private reminder for recurring card benefits, running on Google Apps Script + Sheets + Gmail
inside your own Google account. No third-party services, no bank linking.

## 1. Create the project
1. Open <https://sheets.new> to create a new Google Sheet (this becomes your database).
2. **Extensions → Apps Script.** A script project opens, bound to that sheet.

## 2. Add the code
1. Replace the contents of the default `Code.gs` with this folder's `Code.gs`.
2. Add three HTML files (**＋ → HTML**), named exactly **`Index`**, **`Confirm`**, and
   **`AddCards`**, and paste `Index.html`, `Confirm.html`, and `AddCards.html` into them.
   - Apps Script stores HTML files without the `.html` extension — the names must be `Index`,
     `Confirm`, and `AddCards` so `createTemplateFromFile` finds them.

## 3. Configure (top of `Code.gs`, in `CONFIG`)
- `LANG` — `'en'` or `'zh'`.
- `AUTHORIZED_EMAILS` — leave `[]` for owner-only (the normal, most secure case).
- `TOKEN` — optional under the default private deployment; you can leave it as-is. It only
  matters if you later switch to a shared "Anyone" deployment.
- The web-app URL is **not** set here — you add it as a Script Property in step 5, once you have a
  deployed `/exec` URL (so it survives pasting in new code and never ends up in a commit).
- `DAILY_HOUR`, `SNOOZE_DEFAULT_DAYS` — tune to taste. (`DEFAULT_REMINDER_DAYS` is legacy —
  reminders are now period-driven and don't use it.)

Then set the **project time zone**: ⚙️ **Project Settings → Time zone** → your zone. The daily
reminder hour and the monthly/annual reset boundaries both follow it.

## 4. Initialize
1. In the toolbar, select the `setup` function and click **Run**.
2. Approve the permission prompts (Sheets, Gmail, triggers) — it's your own account.
3. This creates the `Benefits` sheet with example rows, seeds an editable `Catalog` sheet (the
   card/benefit data the Add-cards wizard reads), and schedules the daily reminder.

## 5. Deploy the web app (private)
1. **Deploy → New deployment → Type: Web app.**
2. **Execute as: Me.**
3. **Who has access: Only myself.**  ← this is what keeps it private.
4. **Deploy**, then copy the **Web app URL** (ends in `/exec`). That's your dashboard; reminder
   emails link to it.
5. **Pin it:** in the Apps Script editor, ⚙️ **Project Settings → Script properties → Add script
   property** — Property `WEBAPP_URL`, Value = that `/exec` URL → **Save script properties**. No
   redeploy needed (it's read at run time). This makes reminder-email links reliable regardless of
   trigger context (a daily-trigger run otherwise relies on `getService().getUrl()`, which can
   point at a stale deployment).

> Because access is "Only myself", only your signed-in Google account can open the dashboard or
> the email links. On your own phone you're already signed in, so the links just work.

> **If a link ever shows Google's "Sorry, unable to open the file at this time":** the `/exec`
> deployment's serving state is likely corrupted. Create a **New deployment** (not just a new
> version) to get a fresh `/exec` URL, then **update the `WEBAPP_URL` Script Property to the new
> URL**. See PITFALLS #15.

## 6. Add your cards
Open the web app URL and click **+ Add cards** (top-right), or go straight to `?view=add`. Pick a
card to see its known benefits, tick the ones you have (tweak amounts if needed), add anything
missing with **+ Add another benefit**, then **Add to my tracker**. Don't see your card? Choose
**Other (type a name)** and add its benefits by hand. The wizard skips benefits you already track,
so re-running it is safe.

> The catalog shows a "verified as of" date and is a best-effort snapshot — card terms change, so
> confirm amounts/cadence with your issuer. To edit the catalog itself, open the `Catalog` sheet.

The four seeded example rows in `Benefits` are just placeholders — delete them once you've added
your real cards.

## 7. Use it
- Open the web app URL; bookmark it or **Add to Home Screen** on iPhone.
- When something is due you get an email — tap **Done** or **Snooze**, then confirm on the page
  that opens (the email link itself never changes anything until you confirm).
- Or manage everything on the dashboard: **Mark done / Snooze / Undo / Un-snooze**.

## Sheet columns (`Benefits`)
| Column | Meaning |
|--------|---------|
| ID | stable unique slug, e.g. `amex_uber` |
| Card | display name, e.g. `Amex Gold` |
| Benefit | e.g. `Uber Cash` |
| Amount | free text, e.g. `$10`, `12 visits`, `Unlimited` |
| Category | travel / dining / hotel / streaming / grocery / lounge / other |
| Reset | `monthly`, `quarterly`, `semiannual`, `annual`, or `once` (calendar-based) |
| ReminderDays | legacy — no longer used (reminders are period-driven); safe to ignore |
| LastDonePeriod | managed automatically — leave blank |
| LastReminded | managed automatically |
| SnoozeUntil | managed automatically |

## After any code change
Re-deploy a new version: **Deploy → Manage deployments → (pencil/edit) → Version: New version →
Deploy.** Otherwise the live URL keeps serving the old code.

## Sharing with other people (optional, less secure)
"Only myself" can't grant other people on a personal `@gmail.com`. Options:
- **Google Workspace:** set access to "Anyone with a Google account" and add their address to
  `AUTHORIZED_EMAILS` — identity-checked.
- **Personal Gmail:** the only route is access "Anyone" + a long random `TOKEN` (anyone with the
  link + token can act). Weaker — only do this if you really must.
