import contextlib, hashlib, importlib.util, io, json, pathlib, tempfile, unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).parents[1] / "install-pokoin-rust.py"
spec = importlib.util.spec_from_file_location("installer", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class InstallerTests(unittest.TestCase):
    def test_env_roundtrip_preserves_pem_spaces_and_literal_backslashes(self):
        values={"FIREBASE_PRIVATE_KEY":r"-----BEGIN KEY-----\nabc\n", "DATABASE_URL":"postgres://u:p@localhost/db?x=1&y=2", "NAME":'two words "quoted"'}
        self.assertEqual(module.env_values(module.env_text(values)), values)

    def test_failed_readiness_restores_release_and_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            base=root/"rust";base.mkdir()
            env=base/"pokoin-api.env";env.write_bytes(b"OLD=value\n");env.chmod(0o640)
            unit=root/"service";unit.write_bytes(b"old unit")
            old=base/"old";old.write_bytes(b"old artifact")
            current=base/"current";current.symlink_to(old)
            candidate=root/"candidate";candidate.write_bytes(b"native artifact")
            new_unit=root/"new-unit";new_unit.write_bytes(b"new unit")
            commit="a"*40
            class Args:
                pass
            args=Args();args.candidate=str(candidate);args.unit=str(new_unit);args.commit=commit;args.sha256=hashlib.sha256(candidate.read_bytes()).hexdigest()
            calls=[]
            def run(*command):
                calls.append(command)
                if command[0]==str(candidate):return json.dumps({"commit":commit,"dirty":False})
                if command[:2]==("docker","inspect"):return json.dumps([{"Config":{"Env":["MARKETPLACE_DATABASE_URL=test-only"]}}])
                return ""
            with patch.multiple(module,BASE=base,ENV=env,UNIT=unit,CURRENT=current), patch.object(module,"run",side_effect=run), patch.object(module,"healthy",side_effect=RuntimeError("readiness failed")), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError,"readiness failed"):module.install(args)
            self.assertEqual(current.resolve(),old)
            self.assertEqual(env.read_bytes(),b"OLD=value\n")
            self.assertEqual(unit.read_bytes(),b"old unit")
            self.assertEqual(sum(c==("systemctl","restart",module.SERVICE) for c in calls),2)

if __name__=="__main__":
    unittest.main()
