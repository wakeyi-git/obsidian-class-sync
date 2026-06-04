import { App, Modal, Notice, Setting } from "obsidian";
import qrcode from "qrcode-generator";
import { InvitePayload, buildInviteUri, encodeInvite } from "../core/invite/invite";
import { t } from "../i18n";

/**
 * 학생 초대 표시. 기술문서 §22.4.
 * QR(obsidian:// 딥링크) + 복사 코드. 학생이 폰 카메라로 스캔하거나 코드를 붙여넣어 자동 설정한다.
 */
export class InviteModal extends Modal {
	constructor(
		app: App,
		private payload: InvitePayload,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		const uri = buildInviteUri(this.payload);
		const code = encodeInvite(this.payload);

		contentEl.createEl("h2", {
			text: t("학생 초대 — {name}", { name: this.payload.studentName || this.payload.studentId }),
		});
		contentEl.createEl("p", {
			text: t(
				"학생이 휴대폰 기본 카메라로 아래 QR을 스캔하면 Obsidian이 열리며 자동 설정됩니다. 또는 코드를 복사해 전달하면 학생이 '초대 코드로 설정'에 붙여넣을 수 있습니다.",
			),
		});

		// QR (obsidian:// 딥링크)
		const qrWrap = contentEl.createDiv({ cls: "class-sync-qr" });
		try {
			const qr = qrcode(0, "L");
			qr.addData(uri);
			qr.make();
			// innerHTML 대신 SVG 문자열을 파싱해 element로 삽입(심사 가이드라인: innerHTML 회피).
			const svg = new DOMParser().parseFromString(
				qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true }),
				"image/svg+xml",
			).documentElement;
			qrWrap.empty();
			qrWrap.appendChild(svg);
		} catch (e) {
			qrWrap.createEl("p", {
				text: t("QR 생성 실패: {error}", { error: e instanceof Error ? e.message : String(e) }),
			});
		}

		// 복사 코드
		new Setting(contentEl)
			.setName(t("초대 코드"))
			.setDesc(t("학생에게 전달 → Student Mode '초대 코드로 설정'에 붙여넣기"))
			.addButton((b) =>
				b
					.setButtonText(t("코드 복사"))
					.setCta()
					.onClick(() => this.copy(code, t("초대 코드를 복사했습니다."))),
			)
			.addButton((b) =>
				b.setButtonText(t("딥링크 복사")).onClick(() => this.copy(uri, t("초대 딥링크를 복사했습니다."))),
			);

		const codeEl = contentEl.createEl("textarea", { cls: "class-sync-invite-code" });
		codeEl.value = code;
		codeEl.readOnly = true;
		codeEl.rows = 3;

		contentEl.createEl("p", {
			cls: "class-sync-invite-warn",
			text: t("⚠ 이 초대에는 학생 전용 비밀번호가 포함됩니다(만료 없음). 본인에게만 안전하게 전달하고, 유출이 의심되면 설정에서 ‘비밀번호 재발급’으로 이 초대를 무효화하세요."),
		});
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("이미 설정한 학생은 이 새 코드로 ‘초대 코드로 설정’을 다시 적용해야 연결됩니다(재발급 시 이전 코드는 무효)."),
		});
	}

	private async copy(text: string, ok: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			new Notice(ok);
		} catch {
			new Notice(t("복사 실패 — 코드 상자에서 직접 선택해 복사하세요."));
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
