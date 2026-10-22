use std::process::Command;

#[test]
fn unfinished_inventory_blocks_check_and_apply_before_bundle_or_host_access() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("deploy/x-poko-cutover.sh");
    for mode in ["--check", "--apply"] {
        let output = Command::new("bash")
            .arg(&script)
            .arg(mode)
            .arg("/nonexistent-x-poko-bundle")
            .output()
            .unwrap();
        assert!(!output.status.success());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("CUTOVER BLOCKED"));
        assert!(stderr.contains("D05-D20"));
        assert!(stderr.contains("J10"));
        assert!(!stderr.contains("realpath"));
        assert!(!stderr.contains("must run as root"));
    }
}
