#[tauri::command]
pub async fn send_test_tab(window: tauri::WebviewWindow, reverse: bool) -> Result<(), String> {
    #[cfg(all(feature = "e2e", target_os = "macos"))]
    {
        use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
        use objc2_foundation::{NSPoint, NSString};
        use objc2_web_kit::WKWebView;

        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                let result = (|| {
                    // Run through WebKit's native key path so default focus traversal occurs.
                    let view: &WKWebView = unsafe { &*webview.inner().cast() };
                    let characters = NSString::from_str(if reverse { "\u{19}" } else { "\t" });
                    let modifiers = if reverse {
                        NSEventModifierFlags::Shift
                    } else {
                        NSEventModifierFlags::empty()
                    };
                    for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
                        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                            kind, NSPoint::new(0.0, 0.0), modifiers, 0.0, 0, None,
                            &characters, &NSString::from_str("\t"), false, 48,
                        ).ok_or("Could not create native Tab event")?;
                        if kind == NSEventType::KeyDown {
                            view.keyDown(&event);
                        } else {
                            view.keyUp(&event);
                        }
                    }
                    Ok(())
                })();
                let _ = send.send(result);
            })
            .map_err(|error| error.to_string())?;
        receive
            .await
            .map_err(|_| "Native Tab dispatch was interrupted".to_string())?
    }
    #[cfg(not(all(feature = "e2e", target_os = "macos")))]
    {
        let _ = (window, reverse);
        Err("Native Tab requires a macOS E2E build".into())
    }
}
