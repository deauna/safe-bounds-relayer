import { BigNumber } from 'ethers'
import { AddressZero } from '@ethersproject/constants'
import { expect } from 'chai'
import hre, { deployments, waffle } from 'hardhat'
import '@nomiclabs/hardhat-ethers'
import { deployContract, getTestSafe, getTransactionQueueInstance } from '../utils/setup'
import {
  buildSignatureBytes,
  calculateSafeTransactionHash,
  buildSafeTransaction,
  buildContractCall,
  calculateRelayMessageHash,
  executeTx,
  signHash,
} from '../../src/utils/execution'
import { parseEther } from '@ethersproject/units'
import { chainId } from '../utils/encoding'

describe('SafeTransactionQueueConditionalRefund', async () => {
  const [user1, user2] = waffle.provider.getWallets()

  const setupTests = deployments.createFixture(async ({ deployments }) => {
    await deployments.fixture()

    const transactionQueueInstance = await getTransactionQueueInstance()

    const safe = await getTestSafe(user1, transactionQueueInstance.address)

    const setterSource = `
        contract StorageSetter {
            function setStorage(bytes3 data) public {
                bytes32 slot = 0x7373737373737373737373737373737373737373737373737373737373737373;
                // solhint-disable-next-line no-inline-assembly
                assembly {
                    sstore(slot, data)
                }
            }
        }`
    const storageSetter = await deployContract(user1, setterSource)

    return {
      safe,
      transactionQueueInstance,
      storageSetter,
    }
  })

  describe('getTransactionHash', () => {
    it('should correctly calculate EIP-712 hash of the transaction', async () => {
      const { safe, transactionQueueInstance, storageSetter } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')
      const transactionHash = await transactionQueueInstance.getTransactionHash(
        safe.address,
        safeTransaction.to,
        safeTransaction.value,
        safeTransaction.data,
        safeTransaction.nonce,
        safeTransaction.operation,
      )

      const setStorageTx = buildContractCall(safe.address, storageSetter, 'setStorage', ['0xabcdad'], {
        operation: 1,
      })
      const transactionHash2 = await transactionQueueInstance.getTransactionHash(
        safe.address,
        setStorageTx.to,
        setStorageTx.value,
        setStorageTx.data,
        setStorageTx.nonce,
        setStorageTx.operation,
      )

      expect(transactionHash).to.eq(calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId()))
      expect(transactionHash2).to.eq(calculateSafeTransactionHash(transactionQueueInstance, setStorageTx, await chainId()))
    })
  })

  describe('getRelayMessageHash', () => {
    it('should correctly calculate EIP-712 hash of the relay message', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')
      const transactionHash = await transactionQueueInstance.getTransactionHash(
        safe.address,
        safeTransaction.to,
        safeTransaction.value,
        safeTransaction.data,
        safeTransaction.nonce,
        safeTransaction.operation,
      )
      const relayMessageHash = await transactionQueueInstance.getRelayMessageHash(
        transactionHash,
        AddressZero,
        1000000,
        1000000,
        user1.address,
      )

      expect(relayMessageHash).to.eq(
        calculateRelayMessageHash(
          transactionQueueInstance,
          { safeTxHash: transactionHash, gasToken: AddressZero, maxFeePerGas: 1000000, gasLimit: 1000000, refundReceiver: user1.address },
          await chainId(),
        ),
      )
    })
  })

  describe('execTransaction', () => {
    it('should revert if signature data is not present', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')

      await expect(executeTx(transactionQueueInstance, safeTransaction, [{ signer: user1.address, data: '0x' }])).to.be.revertedWith(
        'GnosisSafeMock: Invalid signature',
      )
    })

    it('should revert if signatures are invalid', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')

      // The mock only supports ECDSA signatures with eth_sign/eip191
      const signature =
        '0x' +
        '000000000000000000000000' +
        user1.address.slice(2) +
        '0000000000000000000000000000000000000000000000000000000000000041' +
        '00' // r, s, v

      await expect(executeTx(transactionQueueInstance, safeTransaction, [{ signer: user1.address, data: signature }])).to.be.revertedWith(
        'GnosisSafeMock: Invalid signature',
      )
    })

    it("should revert if the signed nonce doesn't match current safe nonce", async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '1')

      const transactionHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())

      // The mock only supports ECDSA signatures with eth_sign/eip191
      const signature = await signHash(user1, transactionHash)

      await expect(executeTx(transactionQueueInstance, safeTransaction, [signature])).to.be.revertedWith(
        'GnosisSafeMock: Invalid signature',
      )
    })

    it('should increase the nonce', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      expect(await transactionQueueInstance.safeNonces(safe.address)).to.eq(0)

      await user1.sendTransaction({ to: safe.address, value: parseEther('1') })

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, parseEther('1'), '0x', 0, '0')
      const transactionHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())

      // The mock only supports ECDSA signatures with eth_sign/eip191
      const signature = await signHash(user1, transactionHash)

      await executeTx(transactionQueueInstance, safeTransaction, [signature])

      expect(await transactionQueueInstance.safeNonces(safe.address)).to.eq(1)
    })
  })

  describe('execTransactionWithRefund', () => {
    it('should revert if signature data is not present', async () => {})

    it('should revert if signatures are invalid', async () => {})

    it("should revert if the transaction nonce doesn't match current safe nonce", async () => {})

    it('should increase the nonce', async () => {})

    it('should execute native token transfers', async () => {})

    it('should execute contract calls', async () => {})

    it('should send ether refund', async () => {})

    it('should send token refund', async () => {})
  })
})
