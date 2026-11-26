from __future__ import annotations

import ast
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
from abc import ABC, abstractmethod
from dataclasses import dataclass
from math import ceil
from pathlib import Path
from tempfile import mkdtemp
from time import monotonic, sleep

import psutil

from catalog_ingestor import read_and_validate_step

_ALLOWED_IMPORTS = frozenset({"build123d", "math", "typing", "dataclasses", "enum"})
_FORBIDDEN_NAMES = frozenset({
    "open", "eval", "exec", "compile", "input", "getattr", "setattr", "delattr", "vars", "dir",
    "globals", "locals", "breakpoint", "help", "memoryview", "format", "format_map",
    "os", "sys", "subprocess", "socket", "urllib", "http", "pathlib", "ctypes", "importlib", "builtins",
})
_WORKER_PATH = Path(__file__).with_name("adapter_sandbox_child.py")
_ENVIRONMENT = {
    "HOME": "home",
    "XDG_CACHE_HOME": "cache",
    "TMPDIR": "tmp",
    "MPLCONFIGDIR": "mpl",
}


@dataclass(frozen=True)
class AdapterSandboxResult:
    success: bool
    step_path: Path | None = None
    sha256: str | None = None
    face_count: int = 0
    error: str | None = None
    timed_out: bool = False
    memory_exceeded: bool = False
    elapsed_ms: float = 0.0


def validate_adapter(script: str) -> None:
    if len(script.encode()) > 256_000:
        raise ValueError("CAD adapter script exceeds 256 KB")
    module = ast.parse(script)
    for node in ast.walk(module):
        if isinstance(node, ast.Import):
            imports = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            imports = [node.module] if node.level == 0 else [None]
        else:
            imports = []
        if any(name not in _ALLOWED_IMPORTS for name in imports):
            raise ValueError(f"Import is not allowed in CAD adapters: {imports}")
        names = []
        if isinstance(node, ast.Name):
            names.append(node.id)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(node.name)
        if isinstance(node, ast.Attribute):
            names.append(node.attr)
        if isinstance(node, ast.alias):
            names.extend(name for name in (node.name, node.asname) if name)
        for name in names:
            if name.startswith("_") or name in _FORBIDDEN_NAMES:
                raise ValueError(f"Name is not allowed in CAD adapters: {name}")
    if not any(isinstance(node, ast.FunctionDef) and node.name == "build_part" for node in module.body):
        raise ValueError("CAD adapter must define build_part(params)")


def _prepare_job(script: str, params: dict, work_dir: Path) -> tuple[Path, dict[str, str]]:
    validate_adapter(script)
    work_dir.mkdir(parents=True, exist_ok=True)
    job = Path(mkdtemp(prefix="adapter-", dir=work_dir)).resolve()
    environment = {}
    for name, directory in _ENVIRONMENT.items():
        path = job / directory
        path.mkdir(mode=0o700)
        environment[name] = str(path)
    (job / "adapter.py").write_text(script, encoding="utf-8")
    (job / "params.json").write_text(json.dumps(params, allow_nan=False), encoding="utf-8")
    shutil.copyfile(_WORKER_PATH, job / "worker.py")
    return job, environment


def _validated_result(job: Path, started: float) -> AdapterSandboxResult:
    path = job / "part.step"
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("CAD adapter did not write a regular STEP file")
    if path.stat().st_size > 128 * 1024**2:
        raise RuntimeError("CAD adapter STEP exceeds 128 MB")
    _, digest, faces = read_and_validate_step(path)
    return AdapterSandboxResult(True, path, digest, faces, elapsed_ms=(monotonic() - started) * 1000)


class AdapterSandboxRunner(ABC):
    @abstractmethod
    def run(self, script: str, params: dict, work_dir: Path) -> AdapterSandboxResult:
        raise NotImplementedError


class LocalOsSandboxRunner(AdapterSandboxRunner):
    def __init__(self, *, timeout_s: float = 10, memory_mb: int = 1536):
        if timeout_s <= 0 or memory_mb <= 0:
            raise ValueError("Sandbox time and memory limits must be positive")
        self.timeout_s = timeout_s
        self.memory_mb = memory_mb

    def _sandbox_command(self, job: Path) -> list[str]:
        executable = Path(sys.executable)
        executable_path = executable.resolve()
        venv = Path(sys.prefix)
        base = Path(sys.base_prefix).resolve()
        worker_command = [str(executable), "-I", "-B", str(job / "worker.py"), str(ceil(self.timeout_s))]
        if platform.system() == "Darwin":
            base_executable = Path(sys._base_executable)
            runtime_dirs = {venv, venv.resolve(), base, base_executable.parent.parent,
                            Path("/System/Library"), Path("/usr/lib")}
            rules = [
                "(version 1)", "(deny default)",
                "(allow process-info*)", "(allow sysctl-read)", "(deny network*)",
                f"(allow process-exec (literal {json.dumps(str(executable))}) "
                f"(literal {json.dumps(str(executable_path))}))",
                f"(allow file-write* (subpath {json.dumps(str(job))}))",
                f"(allow file-read* (literal \"/\") (literal \"/dev/null\") (literal \"/dev/urandom\") "
                f"(subpath {json.dumps(str(job))})",
                *(f"  (subpath {json.dumps(str(path))})" for path in sorted(runtime_dirs)),
                ")",
            ]
            ancestors = {*job.parents, *executable.parents, *executable_path.parents}
            for runtime in runtime_dirs:
                ancestors.update(runtime.parents)
            for parent in sorted(ancestors):
                rules.append(f"(allow file-read-metadata (literal {json.dumps(str(parent))}))")
            return ["/usr/bin/sandbox-exec", "-p", "\n".join(rules), *worker_command]

        if platform.system() == "Linux":
            bubblewrap = shutil.which("bwrap")
            prlimit = shutil.which("prlimit")
            if not bubblewrap or not prlimit:
                raise RuntimeError("Linux CAD adapter sandbox requires bubblewrap and prlimit")
            python_libraries = Path(f"/usr/lib/python{sys.version_info.major}.{sys.version_info.minor}")
            runtimes = {venv, venv.resolve(), base} if base not in {Path("/usr"), Path("/usr/local")} else {
                venv, venv.resolve(), python_libraries, Path("/usr/local/lib"), executable_path,
            }
            runtimes.update(Path(path) for path in ("/lib", "/lib64", "/usr/lib"))
            mounts = [arg for path in sorted(runtimes) if path.exists() for arg in ("--ro-bind", str(path), str(path))]
            return [
                prlimit, f"--cpu={ceil(self.timeout_s)}:{ceil(self.timeout_s) + 1}", "--",
                bubblewrap, "--unshare-all", "--die-with-parent", "--dev", "/dev", *mounts,
                "--bind", str(job), str(job), "--chdir", str(job), *worker_command,
            ]
        raise RuntimeError("Local CAD adapter sandbox is unavailable on this operating system")

    def run(self, script: str, params: dict, work_dir: Path) -> AdapterSandboxResult:
        started = monotonic()
        try:
            job, env = _prepare_job(script, params, work_dir)
            env.update(OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1")
            with (job / "adapter.log").open("wb") as output:
                with subprocess.Popen(
                    self._sandbox_command(job), cwd=job, env=env, stdout=output, stderr=output,
                    stdin=subprocess.DEVNULL, start_new_session=True,
                ) as child:
                    failure = self._monitor(child, started)
            if failure is not None:
                return failure
            if child.returncode != 0:
                with (job / "adapter.log").open("rb") as log:
                    log.seek(max(0, log.seek(0, os.SEEK_END) - 4096))
                    detail = log.read().decode("utf-8", errors="replace").strip()
                return AdapterSandboxResult(
                    False, error=detail or f"CAD adapter exited with status {child.returncode}",
                    timed_out=child.returncode == -signal.SIGXCPU, elapsed_ms=(monotonic() - started) * 1000,
                )
            return _validated_result(job, started)
        except (OSError, RuntimeError, ValueError, SyntaxError) as error:
            return AdapterSandboxResult(False, error=str(error), elapsed_ms=(monotonic() - started) * 1000)

    def _monitor(self, child: subprocess.Popen, started: float) -> AdapterSandboxResult | None:
        process = psutil.Process(child.pid)
        while child.poll() is None:
            try:
                rss = sum(item.memory_info().rss for item in [process, *process.children(recursive=True)])
            except psutil.NoSuchProcess:
                continue
            elapsed = monotonic() - started
            memory_exceeded = rss > self.memory_mb * 1024 * 1024
            timed_out = elapsed >= self.timeout_s
            if timed_out or memory_exceeded:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
                return AdapterSandboxResult(
                    False, error="CAD adapter exceeded RSS limit" if memory_exceeded else "CAD adapter timed out",
                    timed_out=timed_out, memory_exceeded=memory_exceeded, elapsed_ms=elapsed * 1000,
                )
            sleep(0.02)
        return None


class DockerContainerSandboxRunner(AdapterSandboxRunner):
    def __init__(
        self, image: str, xbf_cache_dir: Path, *, timeout_s: float = 10, memory_mb: int = 1536, cpus: float = 1,
        pids_limit: int = 32,
    ):
        self.image = image
        self.xbf_cache_dir = xbf_cache_dir
        self.timeout_s = timeout_s
        self.memory_mb = memory_mb
        self.cpus = cpus
        self.pids_limit = pids_limit

    def build_command(self, job: Path, container_name: str | None = None) -> list[str]:
        label = ["--name", container_name] if container_name else []
        return [
            "docker", "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", *label, "--pids-limit", str(self.pids_limit),
            "--memory", f"{self.memory_mb}m", "--cpus", str(self.cpus),
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
            "--user", f"{os.getuid()}:{os.getgid()}",
            "--volume", f"{self.xbf_cache_dir.resolve()}:/xbf_cache:ro",
            "--volume", f"{job.resolve()}:/job:rw", "--workdir", "/job",
            *(arg for name, path in _ENVIRONMENT.items() for arg in ("--env", f"{name}=/job/{path}")),
            "--env", "OMP_NUM_THREADS=1", "--env", "OPENBLAS_NUM_THREADS=1",
            self.image, "python", "-I", "-B", "worker.py", str(ceil(self.timeout_s)),
        ]

    def run(self, script: str, params: dict, work_dir: Path) -> AdapterSandboxResult:
        started = monotonic()
        try:
            job, _ = _prepare_job(script, params, work_dir)
            label = f"zappd-{job.name}"
            try:
                with (job / "adapter.log").open("wb") as output:
                    completed = subprocess.run(
                        self.build_command(job, label), stdout=output, stderr=output, timeout=self.timeout_s,
                        check=False, stdin=subprocess.DEVNULL,
                    )
            except subprocess.TimeoutExpired:
                subprocess.run(["docker", "kill", label], capture_output=True, timeout=5, check=False)
                return AdapterSandboxResult(False, error="CAD adapter timed out", timed_out=True,
                                            elapsed_ms=(monotonic() - started) * 1000)
            if completed.returncode:
                return AdapterSandboxResult(
                    False, error=f"Docker CAD adapter exited with status {completed.returncode}",
                    memory_exceeded=completed.returncode == 137, elapsed_ms=(monotonic() - started) * 1000,
                )
            return _validated_result(job, started)
        except (OSError, RuntimeError, ValueError, SyntaxError) as error:
            return AdapterSandboxResult(False, error=str(error), elapsed_ms=(monotonic() - started) * 1000)
