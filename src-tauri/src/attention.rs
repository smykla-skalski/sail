use notify_rust::{Notification, NotificationResponse};
use tauri::{Emitter, Manager};

#[tauri::command]
pub fn show_attention_notification(
    window: tauri::Window,
    target: serde_json::Value,
    title: String,
    body: String,
    sound: bool,
) -> Result<(), String> {
    let app = window.app_handle().clone();
    let mut notification = Notification::new();
    notification
        .appname("Sail")
        .summary(&title)
        .body(&body)
        .action("default", "Open");

    #[cfg(target_os = "macos")]
    {
        let _ = notify_rust::set_application(&app.config().identifier);
        if sound {
            notification.sound_name("Ping");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if sound {
            notification.sound_name("message-new-instant");
        } else {
            notification.hint(notify_rust::Hint::SuppressSound(true));
        }
    }
    #[cfg(target_os = "windows")]
    {
        notification.app_id(&app.config().identifier);
        if sound {
            notification.sound_name("Default");
        }
    }

    let handle = notification.show().map_err(|error| error.to_string())?;
    std::thread::spawn(move || {
        let _ = handle.wait_for_response(move |response: &NotificationResponse| {
            if matches!(
                response,
                NotificationResponse::Default | NotificationResponse::Action(_)
            ) {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = app.emit("sail-notification-click", target);
            }
        });
    });
    Ok(())
}

#[tauri::command]
pub fn set_attention_badge(window: tauri::Window, count: u32) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    return window
        .set_badge_count(if count == 0 {
            None
        } else {
            Some(i64::from(count))
        })
        .map_err(|error| error.to_string());

    #[cfg(target_os = "windows")]
    return window
        .set_overlay_icon(if count == 0 {
            None
        } else {
            Some(badge_icon(count))
        })
        .map_err(|error| error.to_string());
}

#[cfg(target_os = "windows")]
fn badge_icon(count: u32) -> tauri::image::Image<'static> {
    const DIGITS: [[u8; 5]; 10] = [
        [7, 5, 5, 5, 7],
        [2, 6, 2, 2, 7],
        [7, 1, 7, 4, 7],
        [7, 1, 7, 1, 7],
        [5, 5, 7, 1, 1],
        [7, 4, 7, 1, 7],
        [7, 4, 7, 5, 7],
        [7, 1, 1, 1, 1],
        [7, 5, 7, 5, 7],
        [7, 5, 7, 1, 7],
    ];
    let mut rgba = vec![0_u8; 32 * 32 * 4];
    for y in 0..32_i32 {
        for x in 0..32_i32 {
            if (x - 16).pow(2) + (y - 16).pow(2) <= 15_i32.pow(2) {
                let offset = ((y * 32 + x) * 4) as usize;
                rgba[offset..offset + 4].copy_from_slice(&[220, 45, 55, 255]);
            }
        }
    }
    let digits: Vec<usize> = count
        .min(99)
        .to_string()
        .bytes()
        .map(|digit| usize::from(digit - b'0'))
        .collect();
    let scale = 3;
    let width = digits.len() as i32 * 9 + (digits.len() as i32 - 1) * 2;
    let left = (32 - width) / 2;
    for (index, digit) in digits.iter().enumerate() {
        for (row, mask) in DIGITS[*digit].iter().enumerate() {
            for column in 0..3 {
                if mask & (1 << (2 - column)) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let x = left + index as i32 * 11 + column * scale + dx;
                        let y = 8 + row as i32 * scale + dy;
                        let offset = ((y * 32 + x) * 4) as usize;
                        rgba[offset..offset + 4].copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
    }
    tauri::image::Image::new_owned(rgba, 32, 32)
}
