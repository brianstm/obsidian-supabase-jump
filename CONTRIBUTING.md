# Contributing

Thanks for wanting to help out. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue and include:

- Your plugin version and Obsidian version
- Which device it happened on (Mac, Windows, iPhone, Android, and so on)
- What you did, what you expected, and what happened instead
- Any errors from the developer console, if you can get to it

Please remove your project URL, keys and email from anything you paste.

## Working on the code

```bash
npm install
npm run dev
```

`npm run dev` rebuilds `main.js` whenever you save. Point it at a test vault by cloning the repo into `<test vault>/.obsidian/plugins/supabase-jump/`, then reload Obsidian. Please use a throwaway vault and Supabase project while testing sync changes.

Before you open a pull request:

1. Run `npm run lint` and fix anything it reports.
2. Run `npm run build` to make sure it compiles.
3. Try your change on desktop, and on mobile if it touches syncing or live editing.
4. Keep comments short and only where the code isn't obvious.

If your change needs new database columns or tables, add them to `src/schema.ts` in a way that is safe to run more than once, and make the plugin keep working for people who haven't run the new setup yet.
