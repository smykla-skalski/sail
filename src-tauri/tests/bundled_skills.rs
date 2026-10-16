#[path = "../bundled_skills.rs"]
mod bundled_skills;

use sha2::{Digest, Sha256};
use std::fs;

#[test]
fn bytecode_cache_does_not_mask_source_drift() {
    let root = std::env::temp_dir().join(format!("sail-skill-pin-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("skills/ship-it/scripts/__pycache__")).unwrap();
    let result = std::panic::catch_unwind(|| {
        fs::write(root.join("plugin.json"), "metadata").unwrap();
        fs::write(root.join("skills/ship-it/SKILL.md"), "pinned source").unwrap();
        let digest = |text: &str| -> String {
            Sha256::digest(text.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        };
        let pin = serde_json::json!({
            "skills": {"ship-it": {}},
            "metadata": {"plugin.json": "plugins/ship-it/plugin.json"},
            "files": {
                "plugin.json": digest("metadata"),
                "skills/ship-it/SKILL.md": digest("pinned source")
            }
        });
        fs::write(root.join("skills/sai-pin.json"), pin.to_string()).unwrap();
        bundled_skills::check(&root).unwrap();
        let cache = root.join("skills/ship-it/scripts/__pycache__");
        fs::write(cache.join("bookkeeping.cpython-314.pyc"), "bytecode").unwrap();
        bundled_skills::check(&root).unwrap();
        fs::write(cache.join("extra.py"), "extra source").unwrap();
        assert!(bundled_skills::check(&root)
            .unwrap_err()
            .contains("file list differs"));
        fs::remove_file(cache.join("extra.py")).unwrap();
        fs::write(root.join("skills/ship-it/SKILL.md"), "changed source").unwrap();
        assert!(bundled_skills::check(&root)
            .unwrap_err()
            .contains("file drifted"));
        fs::remove_file(root.join("skills/ship-it/SKILL.md")).unwrap();
        assert!(bundled_skills::check(&root)
            .unwrap_err()
            .contains("file list differs"));
    });
    fs::remove_dir_all(root).unwrap();
    result.unwrap();
}
