// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    loglens_lib::perf::mark("process:main");
    loglens_lib::run()
}
