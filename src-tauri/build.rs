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

    // 前端产物同理：tauri-build 不跟踪 ../dist。若不显式声明，只改前端
    // （pnpm build 重新生成 dist，Rust 代码不变）时 cargo 判定 fresh，
    // release exe 仍嵌入旧前端。逐文件声明更可靠：目录 mtime 不随
    // 同名文件的内容更新而变化，而 Vite 产物是哈希文件名。
    fn walk(dir: &std::path::Path) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path);
                } else if path.is_file() {
                    println!("cargo:rerun-if-changed={}", path.display());
                }
            }
        }
    }
    walk(std::path::Path::new("../dist"));

    tauri_build::build()
}
