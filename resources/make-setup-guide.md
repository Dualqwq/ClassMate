# 如何安装 make（ClassMate 构建指南）

你的工作区根目录里有 **Makefile**，ClassMate 会优先使用 `make` 来构建整个项目。
但目前在系统 PATH 里没有找到 `make` 或 `mingw32-make`，请先按下面任一种方式安装。

## Windows（推荐：MinGW-w64）

ClassMate 使用的 g++ 通常来自 MinGW-w64，它自带的 make 叫 `mingw32-make.exe`：

1. 找到你的 MinGW-w64 安装目录下的 `bin` 文件夹（例如 `C:\mingw64\bin`），
   确认里面有 `mingw32-make.exe`（或 `make.exe`）。
2. 把这个 `bin` 目录加入系统环境变量 **Path**：
   「设置 → 系统 → 关于 → 高级系统设置 → 环境变量 → Path → 新建」。
3. **完全关闭并重新打开 VS Code**（环境变量要重启才生效）。
4. 再次点击 ClassMate Compile 即可。

如果 `bin` 目录里只有 `mingw32-make.exe` 也没关系——ClassMate 会先找 `make`，再找 `mingw32-make`。

也可以用包管理器安装（任选其一，安装后同样要重启 VS Code）：

```bat
winget install ezwinports.make
choco install make
```

## macOS

打开终端执行一次（会弹出安装 Xcode 命令行工具的窗口）：

```sh
xcode-select --install
```

## Linux（Debian / Ubuntu）

```sh
sudo apt update && sudo apt install build-essential
```

安装完成后回到 VS Code，重新点击 **ClassMate Compile**。
