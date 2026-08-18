# Sydney Bao — Portfolio

An Instagram-inspired project portfolio built with React and Vite. Visitors can open project posts, like them, and join public comment threads. See it at [sydneybao.com](https://sydneybao.com/).

## Run locally

```bash
npm install
npm run dev
```

Without cloud environment variables, likes and comments automatically use browser `localStorage`. This keeps the interaction flow available without creating test data. `npm run dev` also mounts the owner-authenticated local upload routes used by the editor.

## Enable Firebase persistence and the owner editor

The production site uses Firebase Authentication and Cloud Firestore on Firebase's free Spark plan. Visitors receive anonymous accounts for likes and comments; one pinned email/password account can edit the profile and publish projects. Social and portfolio content use Firebase's official REST APIs directly. Small serverless routes are used only for owner-authorized GitHub media operations.

1. Create or select a project in the [Firebase console](https://console.firebase.google.com/) and register a Web app.
2. Open **Build → Firestore Database**, create the database in **Production mode**, and choose the region closest to your visitors.
3. Open **Build → Authentication → Sign-in method** and enable both **Anonymous** and **Email/Password** authentication. Under **Users**, create the single portfolio owner account and copy its Firebase UID.
4. In `firebase/firestore.rules`, update the UID and email inside `isOwner()` to match that owner account. The UID in the deployed rules is the authorization boundary; `VITE_FIREBASE_OWNER_EMAIL` only pre-fills the sign-in form.
5. Install the [Firebase CLI](https://firebase.google.com/docs/cli), then deploy the repository's Firestore Security Rules from the project root. Passing the project explicitly avoids creating a local `.firebaserc` file:

   ```bash
   npm install --global firebase-tools
   firebase login
   firebase deploy --only firestore --project YOUR_PROJECT_ID
   ```

   If you do not use the Firebase CLI, paste `firebase/firestore.rules` into the Firestore **Rules** tab and publish it. No custom indexes are currently required.

6. Copy `.env.example` to `.env.local`. Find the Firebase values under **Project settings → General → Your apps → SDK setup and configuration**:

   ```dotenv
   VITE_FIREBASE_API_KEY=replace_with_your_web_api_key
   VITE_FIREBASE_PROJECT_ID=replace_with_your_project_id
   VITE_FIREBASE_OWNER_EMAIL=your_owner_email@example.com
   ```

7. Add the same three variables to the Vercel project's environment variables and redeploy.

Firebase Web API keys identify the project; they are not server secrets. Access is enforced by `firebase/firestore.rules`, so deploy those rules before adding the production variables. Never put a service-account private key in this repository or a `VITE_*` variable.

Anonymous identities persist in a visitor's browser. Clearing browser data or switching devices creates a new identity, so this provides one like per browser identity rather than one like per person. The rules enforce one like per identity, atomic counters, server timestamps, field limits, an 80-comment read cap, and a best-effort ten-second cooldown per identity. A determined bot can mint new anonymous identities; add Firebase App Check token handling before enabling App Check enforcement, and use a trusted backend with CAPTCHA for stronger spam controls.

Comments publish immediately to preserve the Instagram-style interaction. Remove abusive comment documents through the Firebase console and decrement that project's `commentCount` in `portfolioProjects` when moderating. For larger traffic, replace immediate publishing with a reviewed moderation queue.

## Edit the portfolio without code

Select **Sign in** in the site header—or **Edit profile** when the owner session is already active—and use the owner account created in Firebase Authentication. The owner dashboard can:

- edit the displayed name, handle, pronouns, bio, LinkedIn link, and résumé;
- edit any bundled project; and
- publish or delete projects with categories, technology tags, highlights, links, display order, and an ordered image/video carousel.

Deleting a project removes it from the public portfolio while retaining its uploaded GitHub media and Firestore likes/comments. Publishing the same slug again restores it without losing that history.

Existing media can keep using root-relative paths such as `/portfolio/demo.gif`, and externally hosted media can use public HTTPS URLs. The owner editor also supports small local uploads and automatic live-site capture without Firebase Storage.
When the owner session is restored, the header action changes from **Sign in** to **Edit profile**. Replacing the résumé accepts a PDF up to 3 MiB, waits until its immutable GitHub-backed URL is live, and then updates the Firestore profile. The bundled `/SydneyBaoResume.pdf` remains the fallback during deployment or if cloud content is unavailable.

## Enable uploads and automatic project capture

The production deployment uses Vercel Functions for three owner-authenticated routes:

- `/api/media-upload` validates an image, video, or owner résumé PDF and commits it under `public/portfolio/uploads/<project>/`;
- `/api/capture-project` queues `.github/workflows/capture-portfolio-media.yml`, which records a cover and scrolling WebM walkthrough in an isolated GitHub Actions job; and
- `/api/media-status` verifies that every generated file exists in GitHub and is publicly reachable from the deployed site before the editor adds it to a carousel.

The capture browser has no repository-write credentials. A separate job revalidates the generated files and commits only their request-specific media paths. Each commit then triggers the normal Vercel Git deployment.

1. Push this repository, including `.github/workflows/capture-portfolio-media.yml`, to the `main` branch and connect `SydneyBao/Personal-Portfolio` to the Vercel project.
2. Create repository-scoped fine-grained GitHub tokens:
   - `GITHUB_CONTENTS_TOKEN`: **Contents → Read and write**;
   - `GITHUB_ACTIONS_TOKEN`: **Actions → Read and write**.

   One `GITHUB_MEDIA_TOKEN` with both permissions can be used instead. Do not grant access to other repositories, and never use a GitHub token in a `VITE_*` variable.

3. Keep the repository's default `GITHUB_TOKEN` permission read-only; the capture workflow grants `contents: write` only to its separate commit job. If `main` is protected, its branch rules must allow both `github-actions[bot]` and the GitHub account that created `GITHUB_CONTENTS_TOKEN` to push generated media.
4. Add these server-side variables to Vercel. Use the exact production origin; add an exact local origin only while using `vercel dev`:

   ```dotenv
   FIREBASE_PROJECT_ID=sydney-bao-portfolio
   FIREBASE_OWNER_UID=your_firebase_owner_uid
   FIREBASE_OWNER_EMAIL=your_owner_email@example.com
   FIREBASE_OWNER_SIGN_IN_PROVIDER=password
   OWNER_MEDIA_ALLOWED_ORIGINS=https://sydneybao.com
   OWNER_MEDIA_PUBLIC_ORIGIN=https://sydneybao.com

   GITHUB_MEDIA_REPOSITORY=SydneyBao/Personal-Portfolio
   GITHUB_MEDIA_BRANCH=main
   GITHUB_CONTENTS_TOKEN=your_contents_token
   GITHUB_ACTIONS_TOKEN=your_actions_token
   ```

5. Redeploy the Vercel project. Production uploads use these Vercel-only secrets; never add GitHub tokens to a `VITE_*` variable.

### Local uploads

`npm run dev` serves `/api/media-upload`, `/api/capture-project`, and `/api/media-status` directly for local owner editing. The local bridge reuses the same Firebase owner verification and URL/file validation as production. Uploads write the immutable file, create a commit containing only that file, and push it to `SydneyBao/Personal-Portfolio` on `origin/main`; URL captures dispatch the pinned GitHub Actions workflow on `main`. Unrelated staged and unstaged work is left untouched.

Before uploading locally:

1. Run the app from this Git repository on the `main` branch.
2. Make sure `origin` is the SydneyBao portfolio GitHub repository and normal `git push origin main` authentication works. URL capture also needs the saved GitHub credential to have **Actions → Read and write** permission.
3. Keep local `main` synchronized with `origin/main`; the uploader refuses to push unrelated unpublished commits.
4. Start the app with `npm run dev`, sign in as the Firebase owner, and choose the file in the editor.

Local uploads intentionally create and push a Git commit. Local URL capture reads the existing Git credential in memory only and uses it to dispatch the repository workflow; no GitHub token is sent to the browser or written to the project. The editor waits for `https://sydneybao.com` to serve the new immutable URLs before saving them to Firestore. During development, Vite proxies `/portfolio/uploads/` to that production origin so workflow-generated captures display locally without rewriting their portable root-relative URLs.

Manual uploads accept PNG, JPEG, GIF, WebP, MP4, WebM, and PDF files up to 3 MiB each. PDF uploads are reserved for the owner profile résumé. The lower limit leaves room for Base64/JSON overhead under Vercel's request-size limit. Upload request IDs make safe retries reuse the same immutable Git path. For larger videos, use a public HTTPS URL from a dedicated media host instead of committing the binary to Git.

Automatic capture accepts only public HTTPS sites. Private/local addresses, nonstandard ports, credentials, URL query strings, WebSockets, service workers, and unsafe subrequests are blocked. A capture normally needs a few minutes for GitHub Actions and the following Vercel deployment. During that time the editor stays in a processing state and polls the authenticated status route; it adds the cover and walkthrough only after both deployed URLs return the expected media type.

Generated files are immutable and request-specific, so repeated captures do not return stale cached media. They accumulate in Git even after removal from a carousel; periodically delete unused files and commit that cleanup if captures become frequent.

## Commands

```bash
npm run dev         # local development
npm run lint        # ESLint
npm run test:firebase # mocked Firebase content + social adapter tests
npm run test:social # mocked Firebase Auth + Firestore adapter tests
npm run test:media  # owner auth, upload validation, URL safety, and GitHub API tests
npm run build       # production build in dist/
npm run preview     # preview the production build
```
