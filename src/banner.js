// The fleet mark (ASCII of the site's SVG: a V-formation — lead node + two wings) + tagline.
// One source of truth for every surface: cli (start/status/help), init, doctor, codex window.
export const BANNER = `
       \x1b[36m●\x1b[0m
      \x1b[2m/ \\\x1b[0m        \x1b[36mfleet\x1b[0m — a fleet of AI coding agents in your Telegram supergroup
     ●   ●      \x1b[2mself-hosted · local · no account\x1b[0m
    \x1b[2m/     \\\x1b[0m
   \x1b[2m○       ○\x1b[0m
`;

// Compact one-line variant for sub-screens that already have their own heading.
export const MARK = "\x1b[36m🛰  fleet\x1b[0m";
