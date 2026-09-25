# Chrome Web Store listing: Maestro for Chrome

## Short description (132 characters max)

Let the AI agents you run in Maestro use this browser, signed in as you, each in its own tab group, with you watching.

## Description

Maestro for Chrome connects this browser to Maestro, the desktop app where you run your AI coding agents (Claude Code, Codex and others). With it, your agents can open tabs, read pages, click, type, fill in forms and take screenshots, using the sites you are already signed in to.

You stay in charge:
• Each agent works in its own tab group, named after it, and can't touch your other tabs unless you hand one over.
• You see what it does: its cursor moves and clicks on the page, and a pill at the top says "Ana is using this tab", with a Stop button.
• Clicks that send, post, pay or delete wait for your OK in Maestro.
• On a login page or a CAPTCHA, the agent stops and lets you handle it. It never types your passwords.
• Maestro shows a live view of the agent's tab, and can stop any agent at once.

What agents can do with it: go to pages, read the page as a list of buttons and fields, click and type with real mouse and keyboard input, fill forms, attach files from your computer, read the console and network log, answer dialogs, record a GIF of what they did.

Needs the Maestro desktop app on the same computer (Windows). The extension talks only to Maestro, through Chrome's native messaging; it has no server of its own and collects nothing.

## Category

Developer Tools

## Single purpose

Lets the AI agents a user runs in the Maestro desktop app operate this browser on the user's behalf, in their own tab groups, with the user watching and able to stop them.

## Permission justifications

- debugger: Agents act through the Chrome DevTools Protocol on their own tabs: real mouse and keyboard input, screenshots, console and network logs, file attachments. Only tabs in the agent's own group, only when the agent asks.
- tabs: Open, list, switch and close the agent's tabs.
- tabGroups: Keep each agent's tabs in a group named after it, so the user sees which agent has which tab.
- scripting: Read the page as a list of buttons and fields for the agent, fill form fields, and draw the agent's cursor and the "is using this tab" pill on the page.
- nativeMessaging: The only link to the Maestro app on the same computer. There is no server.
- storage: Remember which tab group belongs to which agent during the browser session.
- alarms: Reconnect to Maestro when the service worker wakes up.
- identity, identity.email: Show in Maestro which Chrome profile is connected (by its signed-in email), so the user can pick the right profile.
- Host permission <all_urls>: Agents work on whatever site the user asks them to; the extension acts on a page only when an agent asks.

## Data usage (privacy practices tab)

Collected and used only on the user's computer, passed to the Maestro app and the user's own agents:
- Website content (page text, screenshots)
- User activity (the agent's clicks and typing in its own tabs)
- Personally identifiable information: the profile's email address, shown in Maestro only

Certify: not sold, not used for unrelated purposes, not used for creditworthiness.

Privacy policy: https://github.com/tdat-dev/maestro/blob/master/browser-extension/PRIVACY.md

## Screenshots (1280x800)

1-cursor.png, 2-live-view.png, 3-ask-first.png, 4-popup.png (made by tools/store_shots.mjs).
