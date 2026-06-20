# Docker autostart — запускается задачей планировщика при входе в Windows.
# 1) держит WSL-дистрибутив живым (keep-alive), 2) поднимает docker + контейнер Docker.
# restart=always сам поднимет контейнер после старта демона, но дублируем явно для надёжности.
Start-Process -WindowStyle Hidden wsl -ArgumentList '-d','Ubuntu-22.04','-u','root','--','sleep','infinity'
Start-Sleep -Seconds 3
wsl -d Ubuntu-22.04 -e bash -lc "sudo service docker start; cd /mnt/c/Users/vovav/Desktop/fleet && sudo docker compose -f docker-compose.docker.wsl.yml up -d"
