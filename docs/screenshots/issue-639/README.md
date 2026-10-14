# Agent focus captures

These accepted feature captures were taken on 2026-10-13 from native revision `02ba67b887395d00becdeba099975f1c808076a6`. They show the reported focus layout before the hidden-current-session recovery and before issue #641's missing-report label changes. They are not post-hide regression proof. The fresh hidden-current-session verification is recorded separately in the final native gate report.

The requested content size was 2560×1440. The display clamped the measured content viewport to 2560×1098. PNGs are 5120×2260 pixels at devicePixelRatio 2 and include window decorations. The names describe the measured content viewport. Full-height checks at 1440 and 1200 remain environmentally untested.

`manifest.json` retains the runtime dimensions and measurement expression from the accepted native run. Each view has a light and dark capture:

| View          | Light                                     | Dark                                    |
| ------------- | ----------------------------------------- | --------------------------------------- |
| Main Tasks    | [Light](main-tasks-light-2560x1098.png)   | [Dark](main-tasks-dark-2560x1098.png)   |
| Main Agents   | [Light](main-agents-light-2560x1098.png)  | [Dark](main-agents-dark-2560x1098.png)  |
| Task overview | [Light](overview-light-2560x1098.png)     | [Dark](overview-dark-2560x1098.png)     |
| Split Tasks   | [Light](split-tasks-light-2560x1098.png)  | [Dark](split-tasks-dark-2560x1098.png)  |
| Split Agents  | [Light](split-agents-light-2560x1098.png) | [Dark](split-agents-dark-2560x1098.png) |
