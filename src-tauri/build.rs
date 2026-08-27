fn main() {
    // tauri-build 只跟踪 tauri.conf.json，不跟踪图标文件；若不显式声明，
    // 仅替换 icons/ 下文件（尤其是 icon.ico）不会触发 Windows 资源重编译，
    // exe 里会一直嵌着旧图标。
    for icon in [
        "icons/icon.ico",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }
    tauri_build::build()
}
