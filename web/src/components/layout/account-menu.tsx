import { useState } from "react";
import { App, Button, Dropdown, Form, Input, Modal } from "antd";
import { KeyRound, LogOut, User } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { authErrorMessage, useAuthStore } from "@/stores/use-auth-store";

type ChangePasswordValues = { currentPassword: string; newPassword: string; confirm: string };

export function AccountMenu() {
    const user = useAuthStore((state) => state.user);
    const logout = useAuthStore((state) => state.logout);
    const changePassword = useAuthStore((state) => state.changePassword);
    const navigate = useNavigate();
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [form] = Form.useForm<ChangePasswordValues>();

    if (!user) return null;

    const onSubmit = async (values: ChangePasswordValues) => {
        if (values.newPassword !== values.confirm) {
            message.error("两次输入的新密码不一致");
            return;
        }
        setSubmitting(true);
        try {
            await changePassword(values.currentPassword, values.newPassword);
            message.success("密码已修改");
            setOpen(false);
            form.resetFields();
        } catch (error) {
            message.error(authErrorMessage(error instanceof Error ? error.message : ""));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <>
            <Dropdown
                trigger={["click"]}
                menu={{
                    items: [
                        { key: "password", label: "修改密码", icon: <KeyRound className="size-4" /> },
                        { type: "divider" as const },
                        { key: "logout", label: "退出登录", icon: <LogOut className="size-4" /> },
                    ],
                    onClick: ({ key }) => {
                        if (key === "password") setOpen(true);
                        if (key === "logout") void logout().then(() => navigate("/login", { replace: true }));
                    },
                }}
            >
                <Button type="text" className="!h-8 !px-2" icon={<User className="size-4" />}>
                    {user.username}
                </Button>
            </Dropdown>

            <Modal title="修改密码" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnClose>
                <Form form={form} layout="vertical" onFinish={onSubmit} requiredMark={false}>
                    <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}>
                        <Input.Password autoComplete="current-password" />
                    </Form.Item>
                    <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: "请输入新密码" }, { min: 8, message: "密码至少 8 位" }]}>
                        <Input.Password autoComplete="new-password" />
                    </Form.Item>
                    <Form.Item name="confirm" label="确认新密码" dependencies={["newPassword"]} rules={[{ required: true, message: "请再次输入新密码" }]}>
                        <Input.Password autoComplete="new-password" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block loading={submitting}>
                        确认修改
                    </Button>
                </Form>
            </Modal>
        </>
    );
}
