// 不走控制台子系统：debug 版也不再弹黑窗口。
// 需要看 println!/eprintln! 日志时，把这行临时改回 cfg_attr(not(debug_assertions), ...)。
#![windows_subsystem = "windows"]

fn main() {
    let mut args = std::env::args_os();
    let _ = args.next();
    if matches!(
        args.next().as_deref(),
        Some(flag) if flag == std::ffi::OsStr::new("--update-helper")
    ) {
        let exit_code = floral_notepaper_lib::updater::helper::run_cli(args);
        std::process::exit(exit_code.as_i32());
    }

    floral_notepaper_lib::try_exit_for_cli_version_or_help();
    floral_notepaper_lib::run()
}
