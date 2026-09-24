const COPY = {
  ready: ["Connected to Maestro", "Your agents can use this browser. Each one works in its own tab group."],
  connecting: ["Connecting…", "Reaching the Maestro app."],
  "hub-down": ["Maestro isn't open", "Open Maestro and this connects by itself."],
  "no-host": ["Maestro isn't set up on this computer", "Install or open Maestro once, then restart Chrome."],
  offline: ["Not connected", "Trying again in a few seconds."],
};

const s = await chrome.runtime.sendMessage({ type: "status" });
const [label, detail] = COPY[s.state] ?? COPY.offline;
document.getElementById("state").classList.add(s.state);
document.getElementById("label").textContent = label;
document.getElementById("detail").textContent = detail;
document.getElementById("who").textContent = s.email ? `Profile: ${s.email}` : "";
if (s.agents.length) {
  document.getElementById("agentsBox").hidden = false;
  document.getElementById("agents").replaceChildren(
    ...s.agents.map((a) => {
      const li = document.createElement("li");
      li.textContent = a.name;
      const n = document.createElement("span");
      n.textContent = `${a.tabs} tab${a.tabs === 1 ? "" : "s"}`;
      li.append(n);
      return li;
    }),
  );
}
