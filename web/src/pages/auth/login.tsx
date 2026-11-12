import { useState } from "react";
import { App, Button, Card, Form, Input } from "antd";
import { Link, useNavigate } from "react-router-dom";

import { rehydrateStores } from "@/lib/rehydrate";
import { hasStorageFailure } from "@/lib/remote-storage";
import { authErrorMessage, useAuthStore } from "@/stores/use-auth-store";

type LoginValues = { username: string; password: string };

export default function LoginPage() {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const login = useAuthStore((state) => state.login);
    const [loading, setLoading] = useState(false);

    const onFinish = async (values: LoginValues) => {
        setLoading(true);
        try {
            await login(values.username.trim(), values.password);
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
            <Card className="w-full max-w-sm" title="登录 Infinite Canvas">
                <Form<LoginValues> layout="vertical" onFinish={onFinish} requiredMark={false}>
                    <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                        <Input autoFocus autoComplete="username" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                        <Input.Password autoComplete="current-password" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block loading={loading}>
                        登录
                    </Button>
                </Form>
                <div className="mt-4 text-center text-sm text-stone-500">
                    还没有账号？<Link to="/register">注册一个</Link>
                </div>
            </Card>
        </div>
    );
}
