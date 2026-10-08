use std::{env,process::Command};
fn main(){
 println!("cargo:rerun-if-env-changed=POKOIN_BUILD_COMMIT");
 println!("cargo:rerun-if-env-changed=POKOIN_BUILD_DIRTY");
 let output=Command::new("git").args(["rev-parse","HEAD"]).output().ok();
 let commit=env::var("POKOIN_BUILD_COMMIT").ok().or_else(||output.filter(|o|o.status.success()).map(|o|String::from_utf8_lossy(&o.stdout).trim().to_owned())).unwrap_or_else(||"unknown".into());
 let dirty=env::var("POKOIN_BUILD_DIRTY").unwrap_or_else(|_|"true".into());
 println!("cargo:rustc-env=POKOIN_BUILD_COMMIT={commit}");
 println!("cargo:rustc-env=POKOIN_BUILD_DIRTY={dirty}");
}
