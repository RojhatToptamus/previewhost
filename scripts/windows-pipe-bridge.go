// Disposable CI transport: Windows message pipe -> WSL stdio -> Docker Unix socket.
// No HTTP handling, TCP API listener, or product code is replaced by this fixture.
package main

import (
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/user"

	"github.com/Microsoft/go-winio"
)

func main() {
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
	log.Print("ready: authenticated local message pipe")
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
	command := exec.Command("wsl.exe", "-d", "PreviewhostBackend", "--exec", "socat", "STDIO", "UNIX-CONNECT:/var/run/docker.sock")
	command.Stderr = os.Stderr
	input, err := command.StdinPipe()
	if err != nil {
		log.Print(err)
		return
	}
	output, err := command.StdoutPipe()
	if err != nil {
		log.Print(err)
		return
	}
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
