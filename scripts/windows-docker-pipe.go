// CI transport: Windows message pipe -> WSL stdio -> Docker Unix socket.
// Previewhost runs natively on Windows; only the Linux Engine runs inside WSL.
package main

import (
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/user"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func main() {
	// Closing the bridge (including forced CI cleanup) kills every wsl.exe child.
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer windows.CloseHandle(job)
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		log.Fatal(err)
	}
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		log.Fatal(err)
	}

	account, err := user.Current()
	if err != nil {
		log.Fatal(err)
	}
	listener, err := winio.ListenPipe(os.Args[1], &winio.PipeConfig{
		MessageMode:        true,
		SecurityDescriptor: "O:" + account.Uid + "D:P(A;;GA;;;" + account.Uid + ")(A;;GA;;;SY)(A;;GA;;;BA)",
	})
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()
	if err := os.WriteFile(os.Args[2], []byte("ready"), 0600); err != nil {
		log.Fatal(err)
	}

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go forward(conn)
	}
}

func forward(conn net.Conn) {
	defer conn.Close()
	command := exec.Command("wsl.exe", "-d", "PreviewhostBackend", "--exec", "/usr/bin/socat", "STDIO", "UNIX-CONNECT:/var/run/docker.sock")
	command.Stderr = os.Stderr
	input, err := command.StdinPipe()
	if err != nil {
		log.Print(err)
		return
	}
	defer input.Close()
	output, err := command.StdoutPipe()
	if err != nil {
		log.Print(err)
		return
	}
	defer output.Close()
	if err := command.Start(); err != nil {
		log.Print(err)
		return
	}
	defer command.Process.Kill()
	go func() { _, _ = io.Copy(input, conn); _ = input.Close() }()
	_, _ = io.Copy(conn, output)
	_ = conn.(interface{ CloseWrite() error }).CloseWrite()
	_ = command.Wait()
}
