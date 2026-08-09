use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_PROCESS_DETAIL: usize = 16 * 1024;

#[derive(Clone, Default)]
struct DesktopRuntime(Arc<Mutex<RuntimeState>>);

#[derive(Default)]
struct RuntimeState {
    service: Option<ManagedService>,
    pending_project: Option<PathBuf>,
}

struct ManagedService {
    child: Child,
    project_root: PathBuf,
    project_name: String,
    url: String,
    bootstrap_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    state: &'static str,
    message: String,
    project_name: Option<String>,
    technical_detail: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    project_root: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConfigKind {
    Project,
    Workspace,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SelectedConfig {
    path: PathBuf,
    kind: ConfigKind,
}

struct RuntimePaths {
    node: PathBuf,
    cli: PathBuf,
}

#[tauri::command]
async fn desktop_boot(
    app: AppHandle,
    runtime: tauri::State<'_, DesktopRuntime>,
) -> Result<DesktopStatus, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || boot_sync(&app, &runtime))
        .await
        .map_err(|error| format!("桌面启动任务失败：{error}"))
}

#[tauri::command]
async fn desktop_open_project(
    app: AppHandle,
    runtime: tauri::State<'_, DesktopRuntime>,
    project_path: String,
) -> Result<DesktopStatus, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<DesktopStatus, String> {
        let root = canonical_project_root(Path::new(&project_path))?;
        Ok(open_project_sync(&app, &runtime, root))
    })
    .await
    .map_err(|error| format!("项目打开任务失败：{error}"))?
}

#[tauri::command]
async fn desktop_initialize_project(
    app: AppHandle,
    runtime: tauri::State<'_, DesktopRuntime>,
) -> Result<DesktopStatus, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || initialize_project_sync(&app, &runtime))
        .await
        .map_err(|error| format!("项目初始化任务失败：{error}"))
}

#[tauri::command]
async fn desktop_retry(
    app: AppHandle,
    runtime: tauri::State<'_, DesktopRuntime>,
) -> Result<DesktopStatus, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || retry_sync(&app, &runtime))
        .await
        .map_err(|error| format!("项目重试任务失败：{error}"))
}

fn boot_sync(app: &AppHandle, runtime: &DesktopRuntime) -> DesktopStatus {
    {
        let mut state = lock_runtime(runtime);
        if let Some(service) = state.service.as_mut() {
            match service.child.try_wait() {
                Ok(None) => {
                    let status = ready_status(service);
                    if let Err(error) = navigate_to(app, &service.bootstrap_url) {
                        return error_status("工作台已启动，但页面暂时无法打开", None, error);
                    }
                    return status;
                }
                Ok(Some(exit)) => {
                    state.service = None;
                    return error_status(
                        "上次的工作台已经停止",
                        None,
                        format!("控制服务退出状态：{exit}"),
                    );
                }
                Err(error) => {
                    return error_status("无法检查工作台状态", None, error.to_string());
                }
            }
        }
    }

    if let Some(path) = std::env::var_os("AGENT_TEAM_DESKTOP_PROJECT") {
        return match canonical_project_root(Path::new(&path)) {
            Ok(root) => open_project_sync(app, runtime, root),
            Err(detail) => error_status("测试项目不可用", None, detail),
        };
    }

    match load_settings(app) {
        Ok(Some(root)) => match canonical_project_root(&root) {
            Ok(root) => open_project_sync(app, runtime, root),
            Err(detail) => error_status("上次打开的项目已经不可用", None, detail),
        },
        Ok(None) => needs_project_status(),
        Err(detail) => error_status("无法读取上次的项目", None, detail),
    }
}

fn retry_sync(app: &AppHandle, runtime: &DesktopRuntime) -> DesktopStatus {
    let pending = lock_runtime(runtime).pending_project.clone();
    if let Some(root) = pending {
        return open_project_sync(app, runtime, root);
    }
    boot_sync(app, runtime)
}

fn open_project_sync(app: &AppHandle, runtime: &DesktopRuntime, root: PathBuf) -> DesktopStatus {
    let project_name = project_name(&root);
    let Some(config) = discover_config(&root) else {
        let mut state = lock_runtime(runtime);
        stop_service(&mut state.service);
        state.pending_project = Some(root);
        return DesktopStatus {
            state: "needsSetup",
            message: "这个项目还没有 Agent Team 配置".into(),
            project_name: Some(project_name),
            technical_detail: Some("未找到 agent-team.yaml".into()),
        };
    };

    let mut state = lock_runtime(runtime);
    stop_service(&mut state.service);
    state.pending_project = Some(root.clone());
    let paths = match resolve_runtime_paths(app) {
        Ok(paths) => paths,
        Err(detail) => return error_status("桌面运行环境尚未准备好", Some(project_name), detail),
    };
    match start_service(&paths, &root, &config) {
        Ok(service) => {
            let status = ready_status(&service);
            let bootstrap_url = service.bootstrap_url.clone();
            state.service = Some(service);
            state.pending_project = None;
            drop(state);
            if let Err(detail) = save_settings(app, &root) {
                return error_status("项目已打开，但无法记住本次选择", Some(project_name), detail);
            }
            if let Err(detail) = navigate_to(app, &bootstrap_url) {
                return error_status(
                    "工作台已启动，但页面暂时无法打开",
                    Some(project_name),
                    detail,
                );
            }
            status
        }
        Err(detail) => error_status("这个项目暂时无法打开", Some(project_name), detail),
    }
}

fn initialize_project_sync(app: &AppHandle, runtime: &DesktopRuntime) -> DesktopStatus {
    let root = match lock_runtime(runtime).pending_project.clone() {
        Some(root) => root,
        None => return needs_project_status(),
    };
    if discover_config(&root).is_none() {
        let paths = match resolve_runtime_paths(app) {
            Ok(paths) => paths,
            Err(detail) => {
                return error_status("桌面运行环境尚未准备好", Some(project_name(&root)), detail)
            }
        };
        let mut command = Command::new(&paths.node);
        command
            .arg(&paths.cli)
            .arg("init")
            .arg(&root)
            .current_dir(&root);
        let output = match run_command_with_timeout(&mut command, INITIALIZE_TIMEOUT) {
            Ok(output) => output,
            Err(detail) => {
                return error_status("无法初始化这个项目", Some(project_name(&root)), detail)
            }
        };
        if !output.status.success() {
            return error_status(
                "无法初始化这个项目",
                Some(project_name(&root)),
                process_output_detail(output.stdout.as_bytes(), output.stderr.as_bytes()),
            );
        }
    }
    open_project_sync(app, runtime, root)
}

fn start_service(
    paths: &RuntimePaths,
    root: &Path,
    config: &SelectedConfig,
) -> Result<ManagedService, String> {
    let token = random_session_token();
    let mut command = Command::new(&paths.node);
    command
        .arg(&paths.cli)
        .arg("serve")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("0")
        .arg(match config.kind {
            ConfigKind::Project => "--config",
            ConfigKind::Workspace => "--workspace",
        })
        .arg(&config.path)
        .current_dir(root)
        .env("AGENT_TEAM_SESSION_TOKEN", &token)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 让控制服务独占一个进程组，terminate_child 才能按组整棵清理。
        command.process_group(0);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "无法启动控制服务（{}）：{error}",
            paths.node.to_string_lossy()
        )
    })?;
    let stdout = child.stdout.take().ok_or("无法读取控制服务启动状态")?;
    let stderr = child.stderr.take().ok_or("无法读取控制服务错误信息")?;
    let (line_sender, line_receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line_sender.send(line).is_err() {
                break;
            }
        }
    });
    let stderr_detail = Arc::new(Mutex::new(String::new()));
    let stderr_target = Arc::clone(&stderr_detail);
    thread::spawn(move || collect_process_detail(stderr, stderr_target));

    let started = Instant::now();
    let url = loop {
        match line_receiver.recv_timeout(Duration::from_millis(150)) {
            Ok(line) => {
                if let Some(url) = parse_service_url(&line) {
                    break url;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let exit = child
                    .wait()
                    .map(|status| status.to_string())
                    .unwrap_or_else(|error| error.to_string());
                return Err(format!(
                    "控制服务启动后立即退出（{exit}）{}",
                    process_detail_suffix(&stderr_detail)
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if let Ok(Some(exit)) = child.try_wait() {
            return Err(format!(
                "控制服务启动后立即退出（{exit}）{}",
                process_detail_suffix(&stderr_detail)
            ));
        }
        if started.elapsed() >= STARTUP_TIMEOUT {
            terminate_child(&mut child);
            return Err(format!(
                "等待控制服务就绪超时{}",
                process_detail_suffix(&stderr_detail)
            ));
        }
    };

    Ok(ManagedService {
        child,
        project_root: root.to_path_buf(),
        project_name: project_name(root),
        bootstrap_url: format!("{url}/__agent_team/session?token={token}"),
        url,
    })
}

fn collect_process_detail(mut stream: impl Read, target: Arc<Mutex<String>>) {
    let mut buffer = [0_u8; 1024];
    while let Ok(read) = stream.read(&mut buffer) {
        if read == 0 {
            break;
        }
        let mut detail = target
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if detail.len() >= MAX_PROCESS_DETAIL {
            continue;
        }
        let remaining = MAX_PROCESS_DETAIL - detail.len();
        let chunk = String::from_utf8_lossy(&buffer[..read]);
        detail.push_str(&chunk.chars().take(remaining).collect::<String>());
    }
}

fn process_detail_suffix(detail: &Arc<Mutex<String>>) -> String {
    let value = detail
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .trim()
        .to_string();
    if value.is_empty() {
        String::new()
    } else {
        format!("：{value}")
    }
}

fn process_output_detail(stdout: &[u8], stderr: &[u8]) -> String {
    let detail = if stderr.is_empty() { stdout } else { stderr };
    String::from_utf8_lossy(detail).trim().to_string()
}

struct CommandOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

/// 运行一个短生命周期命令，stdout/stderr 限量收集，超过 timeout 后按整棵进程树终止。
fn run_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 与 start_service 一致：独立进程组，超时时 terminate_child 才能整组清理。
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout_detail = Arc::new(Mutex::new(String::new()));
    let stderr_detail = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let target = Arc::clone(&stdout_detail);
        readers.push(thread::spawn(move || {
            collect_process_detail(stdout, target)
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let target = Arc::clone(&stderr_detail);
        readers.push(thread::spawn(move || {
            collect_process_detail(stderr, target)
        }));
    }

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    terminate_child(&mut child);
                    return Err(format!(
                        "命令运行超过 {} 秒仍未完成，已终止{}",
                        timeout.as_secs(),
                        process_detail_suffix(&stderr_detail)
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                terminate_child(&mut child);
                return Err(error.to_string());
            }
        }
    };
    let _ = child.wait();
    for reader in readers {
        let _ = reader.join();
    }
    let stdout = stdout_detail
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .trim()
        .to_string();
    let stderr = stderr_detail
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .trim()
        .to_string();
    Ok(CommandOutput {
        status,
        stdout,
        stderr,
    })
}

fn parse_service_url(line: &str) -> Option<String> {
    let url = line
        .split_whitespace()
        .find(|part| part.starts_with("http://127.0.0.1:"))?;
    let port = url.strip_prefix("http://127.0.0.1:")?.parse::<u16>().ok()?;
    if port == 0 {
        return None;
    }
    Some(url.to_string())
}

fn resolve_runtime_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    if let (Ok(node), Ok(cli)) = (
        std::env::var("AGENT_TEAM_DESKTOP_NODE"),
        std::env::var("AGENT_TEAM_DESKTOP_CLI"),
    ) {
        return Ok(RuntimePaths {
            node: PathBuf::from(node),
            cli: PathBuf::from(cli),
        });
    }

    let resource_cli = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("runtime/dist/cli.js");
    let sibling_node = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .map(|parent| {
            parent.join(if cfg!(windows) {
                "agent-team-node.exe"
            } else {
                "agent-team-node"
            })
        });
    if resource_cli.is_file() && sibling_node.as_ref().is_some_and(|path| path.is_file()) {
        return Ok(RuntimePaths {
            node: sibling_node.unwrap(),
            cli: resource_cli,
        });
    }

    let development_cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/cli.js");
    if development_cli.is_file() {
        eprintln!(
            "Agent Team desktop warning: 未找到随 App 安装的运行时（期望 {} 与 {}），回退到开发路径 {}",
            resource_cli.to_string_lossy(),
            sibling_node
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| "<无法定位 node 可执行文件>".into()),
            development_cli.to_string_lossy()
        );
        return Ok(RuntimePaths {
            node: PathBuf::from("node"),
            cli: development_cli,
        });
    }
    Err("未找到随 App 安装的控制服务文件，请重新安装 Agent Team".into())
}

fn discover_config(root: &Path) -> Option<SelectedConfig> {
    ["agent-team.workspace.yaml", "agent-team.workspace.yml"]
        .into_iter()
        .map(|name| root.join(name))
        .find(|path| path.is_file())
        .map(|path| SelectedConfig {
            path,
            kind: ConfigKind::Workspace,
        })
        .or_else(|| {
            ["agent-team.yaml", "agent-team.yml"]
                .into_iter()
                .map(|name| root.join(name))
                .find(|path| path.is_file())
                .map(|path| SelectedConfig {
                    path,
                    kind: ConfigKind::Project,
                })
        })
}

fn canonical_project_root(path: &Path) -> Result<PathBuf, String> {
    let root = path
        .canonicalize()
        .map_err(|error| format!("无法访问所选文件夹：{error}"))?;
    if !root.is_dir() {
        return Err("所选位置不是文件夹".into());
    }
    Ok(root)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("desktop.json"))
        .map_err(|error| error.to_string())
}

fn load_settings(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let path = settings_path(app)?;
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let settings: DesktopSettings =
        serde_json::from_slice(&contents).map_err(|error| error.to_string())?;
    Ok(Some(settings.project_root))
}

fn save_settings(app: &AppHandle, root: &Path) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let settings = DesktopSettings {
        project_root: root.to_path_buf(),
    };
    let contents = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn navigate_to(app: &AppHandle, destination: &str) -> Result<(), String> {
    let url = destination
        .parse::<tauri::Url>()
        .map_err(|error| error.to_string())?;
    app.get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?
        .navigate(url)
        .map_err(|error| error.to_string())
}

fn ready_status(service: &ManagedService) -> DesktopStatus {
    DesktopStatus {
        state: "ready",
        message: "项目已就绪".into(),
        project_name: Some(service.project_name.clone()),
        technical_detail: Some(format!(
            "项目：{}\n服务：{}",
            service.project_root.to_string_lossy(),
            service.url
        )),
    }
}

fn needs_project_status() -> DesktopStatus {
    DesktopStatus {
        state: "needsProject",
        message: "选择一个代码项目开始".into(),
        project_name: None,
        technical_detail: None,
    }
}

fn error_status(
    message: impl Into<String>,
    project_name: Option<String>,
    detail: impl Into<String>,
) -> DesktopStatus {
    let detail = detail.into();
    eprintln!("Agent Team desktop error: {detail}");
    DesktopStatus {
        state: "error",
        message: message.into(),
        project_name,
        technical_detail: Some(detail),
    }
}

fn project_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("当前项目")
        .to_string()
}

fn random_session_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn lock_runtime(runtime: &DesktopRuntime) -> std::sync::MutexGuard<'_, RuntimeState> {
    runtime
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn stop_service(service: &mut Option<ManagedService>) {
    if let Some(mut service) = service.take() {
        terminate_child(&mut service.child);
    }
}

fn terminate_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        // node 侧用 detached:true 派生的 agent/git 子进程自成进程组，killpg 打不到，
        // 先保持 node 存活并按 PPID 清理后代，避免父进程退出后失去 detached 子进程。
        for descendant in descendant_pids(pid) {
            unsafe {
                libc::kill(descendant, libc::SIGTERM);
            }
        }
        let started = Instant::now();
        while started.elapsed() < SHUTDOWN_TIMEOUT {
            if descendant_pids(pid).is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        // 重新枚举后再强杀，避免对已经退出并被系统复用的旧 PID 发信号。
        for descendant in descendant_pids(pid) {
            unsafe {
                libc::kill(descendant, libc::SIGKILL);
            }
        }

        // 子进程由 process_group(0) 独立成组，负 PID 即整个进程组。
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
        let started = Instant::now();
        while started.elapsed() < SHUTDOWN_TIMEOUT {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        // 父进程仍存活时重新枚举是安全的；此时后代仍属于这棵进程树。
        for descendant in descendant_pids(pid) {
            unsafe {
                libc::kill(descendant, libc::SIGKILL);
            }
        }
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    #[cfg(windows)]
    {
        let _ = child.kill();
        let started = Instant::now();
        while started.elapsed() < SHUTDOWN_TIMEOUT {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// 通过 pgrep -P 递归枚举某个进程的全部后代（无论它们是否 detached 换了进程组）。
#[cfg(unix)]
fn descendant_pids(root: libc::pid_t) -> Vec<libc::pid_t> {
    let mut descendants = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        let output = Command::new("pgrep")
            .arg("-P")
            .arg(parent.to_string())
            .output();
        let Ok(output) = output else { continue };
        if !output.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Ok(pid) = line.trim().parse::<libc::pid_t>() {
                frontier.push(pid);
                descendants.push(pid);
            }
        }
    }
    descendants
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopRuntime::default())
        .invoke_handler(tauri::generate_handler![
            desktop_boot,
            desktop_open_project,
            desktop_initialize_project,
            desktop_retry
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Agent Team desktop application");

    app.run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            if let Some(runtime) = app.try_state::<DesktopRuntime>() {
                stop_service(&mut lock_runtime(&runtime).service);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;
    use tempfile::tempdir;

    #[test]
    fn discovers_workspace_before_project_config() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("agent-team.yaml"), "project: {}").unwrap();
        fs::write(
            root.path().join("agent-team.workspace.yaml"),
            "projects: []",
        )
        .unwrap();

        let selected = discover_config(root.path()).unwrap();
        assert_eq!(selected.kind, ConfigKind::Workspace);
        assert_eq!(
            selected.path.file_name().unwrap(),
            "agent-team.workspace.yaml"
        );
    }

    #[test]
    fn accepts_only_valid_loopback_service_urls() {
        assert_eq!(
            parse_service_url("Agent Team control service: http://127.0.0.1:4317"),
            Some("http://127.0.0.1:4317".into())
        );
        assert_eq!(
            parse_service_url("Agent Team workspace control service: http://127.0.0.1:61234"),
            Some("http://127.0.0.1:61234".into())
        );
        assert_eq!(parse_service_url("http://example.com:4317"), None);
        assert_eq!(parse_service_url("http://127.0.0.1:0"), None);
    }

    #[test]
    fn generates_full_length_session_tokens() {
        let first = random_session_token();
        let second = random_session_token();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn starts_authenticated_control_service_and_stops_it() {
        let root = tempdir().unwrap();
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let paths = RuntimePaths {
            node: PathBuf::from("node"),
            cli: repository.join("dist/cli.js"),
        };
        let init = Command::new(&paths.node)
            .arg(&paths.cli)
            .arg("init")
            .arg(root.path())
            .output()
            .unwrap();
        assert!(
            init.status.success(),
            "{}",
            process_output_detail(&init.stdout, &init.stderr)
        );
        let config = discover_config(root.path()).unwrap();
        let mut service = start_service(&paths, root.path(), &config).unwrap();

        let unauthorized = http_get(&service.url, "/api/health", None);
        assert!(unauthorized.starts_with("HTTP/1.1 401"), "{unauthorized}");
        let bootstrap_path = service.bootstrap_url.strip_prefix(&service.url).unwrap();
        let bootstrap = http_get(&service.url, bootstrap_path, None);
        assert!(bootstrap.starts_with("HTTP/1.1 303"), "{bootstrap}");
        let cookie = bootstrap
            .lines()
            .find_map(|line| line.strip_prefix("Set-Cookie: "))
            .and_then(|line| line.split(';').next())
            .unwrap();
        let health = http_get(&service.url, "/api/health", Some(cookie));
        assert!(health.starts_with("HTTP/1.1 200"), "{health}");
        assert!(health.contains("\"status\":\"ok\""), "{health}");

        terminate_child(&mut service.child);
        assert!(service.child.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn terminate_kills_detached_descendants() {
        let root = tempdir().unwrap();
        // 模拟 node 侧 detached:true 派生 agent 子进程：孙进程自成进程组，
        // 纯 killpg 打不到，terminate_child 必须连同它一起清掉。
        let script = root.path().join("detached-parent.js");
        fs::write(
            &script,
            r#"
            const { spawn } = require("child_process");
            const fs = require("fs");
            const path = require("path");
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
                detached: true,
                stdio: "ignore",
            });
            fs.writeFileSync(path.join(__dirname, "grandchild.pid"), String(child.pid));
            console.log("control service: http://127.0.0.1:4317");
            setInterval(() => {}, 1000);
            "#,
        )
        .unwrap();
        let paths = RuntimePaths {
            node: PathBuf::from("node"),
            cli: script,
        };
        let config = SelectedConfig {
            path: root.path().join("agent-team.yaml"),
            kind: ConfigKind::Project,
        };
        let mut service = start_service(&paths, root.path(), &config).unwrap();

        // start_service 用 process_group(0) 让服务独立成组。
        let pid = service.child.id() as libc::pid_t;
        assert_eq!(unsafe { libc::getpgid(pid) }, pid);

        let grandchild_pid: libc::pid_t = {
            let pid_path = root.path().join("grandchild.pid");
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(contents) = fs::read_to_string(&pid_path) {
                    if let Ok(pid) = contents.trim().parse() {
                        break pid;
                    }
                }
                assert!(Instant::now() < deadline, "孙进程 pid 文件未出现");
                thread::sleep(Duration::from_millis(50));
            }
        };
        assert_eq!(unsafe { libc::kill(grandchild_pid, 0) }, 0, "孙进程应存活");
        assert_ne!(
            unsafe { libc::getpgid(grandchild_pid) },
            pid,
            "detached 孙进程不在服务的进程组里"
        );

        terminate_child(&mut service.child);
        assert!(service.child.try_wait().unwrap().is_some());

        let mut gone = false;
        for _ in 0..40 {
            if unsafe { libc::kill(grandchild_pid, 0) } != 0 {
                gone = true;
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(gone, "detached 孙进程在 terminate 后仍存活");
    }

    #[cfg(unix)]
    #[test]
    fn run_command_with_timeout_kills_overrunning_command() {
        let mut command = Command::new("node");
        command.arg("-e").arg("setInterval(() => {}, 1000)");
        let started = Instant::now();
        let error = run_command_with_timeout(&mut command, Duration::from_millis(500))
            .err()
            .expect("超时命令应报错");
        assert!(error.contains("已终止"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "超时路径不应长时间阻塞"
        );
    }

    #[test]
    fn run_command_with_timeout_captures_failure_output() {
        let mut command = Command::new("node");
        command
            .arg("-e")
            .arg("console.error('init failed here'); process.exit(3)");
        let output = run_command_with_timeout(&mut command, Duration::from_secs(30)).unwrap();
        assert!(!output.status.success());
        assert_eq!(output.stderr, "init failed here");
    }

    fn http_get(base_url: &str, path: &str, cookie: Option<&str>) -> String {
        let port = base_url
            .strip_prefix("http://127.0.0.1:")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let cookie_header = cookie
            .map(|value| format!("Cookie: {value}\r\n"))
            .unwrap_or_default();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{cookie_header}Connection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }
}
