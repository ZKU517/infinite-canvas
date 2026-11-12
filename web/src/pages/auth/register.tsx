import { useState } from "react";
import { App, Button, Card, Form, Input } from "antd";
import { Link, useNavigate } from "react-router-dom";

import { rehydrateStores } from "@/lib/rehydrate";
import { hasStorageFailure } from "@/lib/remote-storage";
import { authErrorMessage, useAuthStore } from "@/stores/use-auth-store";

type RegisterValues = { username: string; password: string; confirm: string };

export default function RegisterPage() {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const register = useAuthStore((state) => state.register);
    const [loading, setLoading] = useState(false);

    const onFinish = async (values: RegisterValues) => {
        if (values.password !== values.confirm) {
            message.error("两次输入的密码不一致");
            return;
        }
        setLoading(true);
        try {
            await register(values.username.trim(), values.password);
            await rehydrateStores();
            if (hasStorageFailure()) {
                message.error("数据加载失败，请刷新页面重试（已暂停保存，避免覆盖服务器数据）");
                return;
            }
            navigate("/", { replace: true });
        } catch (error) {
            message.error(authErrorMessage(error instanceof Error ? error.message : ""));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex min-h-dvh items-center justify-center bg-stone-100 px-4 dark:bg-stone-950">
            <Card className="w-full max-w-sm" title="注册 Infinite Canvas">
                <Form<RegisterValues> layout="vertical" onFinish={onFinish} requiredMark={false}>
                    <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }, { pattern: /^[A-Za-z0-9_-]{3,32}$/, message: "3-32 位字母、数字、_ 或 -" }]}>
                        <Input autoFocus autoComplete="username" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }, { min: 8, message: "密码至少 8 位" }]}>
                        <Input.Password autoComplete="new-password" />
                    </Form.Item>
                    <Form.Item name="confirm" label="确认密码" dependencies={["password"]} rules={[{ required: true, message: "请再次输入密码" }]}>
                        <Input.Password autoComplete="new-password" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block loading={loading}>
                        注册并登录
                    </Button>
                </Form>
                <div className="mt-4 text-center text-sm text-stone-500">
                    已有账号？<Link to="/login">返回登录</Link>
                </div>
            </Card>
        </div>
    );
}
