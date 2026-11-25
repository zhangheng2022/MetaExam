# MetaExam

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

用户确认 Node.js、NestJS、Fastify、React、Ant Design、Electron、PostgreSQL。Web 与 Electron 使用 packages/ui 中统一的 Ant Design 组件与中文主题配置。

界面采用用户指定的 Ant Design 默认蓝色主题，主操作及导航选中态使用默认主色 #1677ff。

## Users

学校管理员维护部署电脑；教师组织考试；学生在局域网浏览器作答。

## Product Purpose

本地运行的考试系统。第一阶段只验证运行环境、数据库、后台任务和本地授权。

## Operating Context

Windows 普通电脑作为服务器，无互联网仍能安装、激活与使用。当前开发电脑不注册服务；净机安装与重启在尚未准备的独立环境验收。

## Capabilities and Constraints

授权必须 Node.js 本地 Ed25519 验签，无在线授权依赖。状态页面展示真实状态，不展示虚构考试数据。私钥不进入客户安装包。

## Product Principles

已确认数据持久化；维护与考试进程分离；错误可诊断；不把待验收能力标记完成。
