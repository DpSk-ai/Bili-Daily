from rembg import remove, new_session
from PIL import Image
import os
from pathlib import Path

def test_rembg_setup():
    """
    验收测试：检查 rembg 和 isnet-anime 是否正确安装
    """
    print("=" * 60)
    print("Bili Daily - rembg isnet-anime 安装验收测试")
    print("=" * 60)
    print()

    # 测试 1：导入检查
    print("[1/4] 检查 rembg 导入...")
    try:
        from rembg import remove, new_session
        print("✓ rembg 导入成功")
    except ImportError as e:
        print(f"✗ rembg 导入失败: {e}")
        return False

    # 测试 2：加载模型
    print("[2/4] 加载 isnet-anime 模型...")
    try:
        session = new_session('isnet-anime')
        print("✓ isnet-anime 模型加载成功")
    except Exception as e:
        print(f"✗ 模型加载失败: {e}")
        return False

    # 测试 3：创建测试目录
    print("[3/4] 准备测试目录...")
    test_input_dir = Path("neo-images")
    test_output_dir = Path("output")

    test_input_dir.mkdir(exist_ok=True)
    test_output_dir.mkdir(exist_ok=True)
    print(f"✓ 目录创建/检查成功")
    print(f"  - 输入目录: {test_input_dir.resolve()}")
    print(f"  - 输出目录: {test_output_dir.resolve()}")

    # 测试 4：创建示例
    print("[4/4] 生成使用示例...")
    example_code = '''
# rembg isnet-anime 使用示例

from rembg import remove, new_session
from PIL import Image

# 加载动漫人物分割模型
session = new_session('isnet-anime')

# 读取原始图像
input_image = Image.open('neo-images/NEO_character.png')

# 移除背景（透明化）
output_image = remove(input_image, session=session)

# 保存结果
output_image.save('output/NEO_character_transparent.png')

print('✓ 背景移除完成！')
'''

    example_file = Path("process_neo.py")
    example_file.write_text(example_code, encoding='utf-8')
    print(f"✓ 示例脚本已生成: {example_file.resolve()}")

    print()
    print("=" * 60)
    print("✓ 所有验收测试通过！")
    print("=" * 60)
    print()
    print("下一步：")
    print("1. 将 NEO 角色图像放入 neo-images/ 目录")
    print("2. 运行: python process_neo.py")
    print("3. 查看结果: output/ 目录中的透明背景 PNG")
    print()
    print("模型存储位置:")
    print(f"  {Path.home() / '.rembg' / 'models' / 'isnet-anime'}")

    return True

if __name__ == '__main__':
    success = test_rembg_setup()
    exit(0 if success else 1)
