# Queue pause reason manual checks

Tested the isolated, signed macOS app built with `npm run build:e2e`, using the embedded WebDriver and the ACP fixture agent.

- A failed prompt paused the queue and showed "Queue paused." with the fixture error next to Retry queue
- After opening a Codex thread and switching back, the composer error was cleared but the pause reason stayed visible
- Retry queue delivered the queued message and removed the pause row
- At 390 px and 320 px, document scroll width matched client width and the row wrapped below the reason

## Viewport evidence

Measured through `browser.execute(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }))`.

| Requested window | Actual content viewport | Screenshot pixels | Themes         |
| ---------------- | ----------------------- | ----------------- | -------------- |
| 2560 by 1440     | 2560 by 1098            | 5120 by 2260      | Light and dark |
| 1920 by 1200     | 1920 by 1098            | 3840 by 2260      | Light and dark |
| 390 by 900       | 390 by 868              | 780 by 1800       | Dark           |
| 320 by 900       | 320 by 868              | 640 by 1800       | Dark           |

The display clamped the requested window heights. Full-height 2560 by 1440 and 1920 by 1200 content viewports remain untested. 200% zoom and keyboard focus were not rechecked; the change adds no new focus target beyond the existing Retry queue button.
