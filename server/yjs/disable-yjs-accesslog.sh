#!/bin/sh
# ---------------------------------------------------------------------------
# yjs 역방향 프록시 vhost의 access_log를 끈다.
#   토큰은 WebSocket URL 쿼리(?token=)로 전달되므로, 프록시 접근 로그에
#   평문으로 쌓이는 것을 막는다.
#   DSM이 역방향 프록시 설정을 재생성하면 사라지므로, '부팅' 트리거(작업
#   스케줄러, 사용자=root)로 재적용한다.
# ---------------------------------------------------------------------------
HOST="yjs.wakeyi.synology.me"

# yjs(1234)를 프록시하는 실제 nginx 설정 파일 찾기
CONF=$(grep -rls "$HOST" /etc/nginx /usr/syno/etc 2>/dev/null \
        | xargs grep -ls '1234' 2>/dev/null | head -n1)

if [ -z "$CONF" ]; then
  logger -t yjs-nolog "conf not found (host=$HOST)"
  exit 1
fi

# 아직 적용 전이면 server_name 줄 뒤에 access_log off; 삽입(중복 방지 마커)
if ! grep -q '# yjs-nolog' "$CONF"; then
  sed -i "/server_name[[:space:]].*$HOST/a\\    access_log off; # yjs-nolog" "$CONF"
  logger -t yjs-nolog "injected access_log off into $CONF"
fi

# 설정 검증 후 무중단 reload, 실패 시 단계적 fallback
( /usr/sbin/nginx -t && /usr/sbin/nginx -s reload ) 2>/dev/null \
  || synosystemctl reload  nginx 2>/dev/null \
  || synosystemctl restart nginx 2>/dev/null

logger -t yjs-nolog "reloaded nginx"
